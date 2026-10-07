"""HTTP-level tests, including the whole pipeline against the mock stores."""

import pytest

SAMPLE = "1L amul milk, eggs, 2 maggi, aashirvaad atta 5kg, onion 1kg, britannia bread, catch hing, dragonfruit"


def pipeline(client, text, pick=0, max_apps=None):
    items = client.post("/parse", json={"text": text}).json()["items"]
    found = client.post("/mock/collect", json={"items": items}).json()
    matches = client.post("/match", json={"items": items, "candidates": found["candidates"]}).json()["matches"]
    opt_items = []
    for item, match in zip(items, matches):
        offers = {}
        if match["needs_user"]:
            options = match["substitutes"] or match["variants"]
            chosen = options[pick]["per_app"] if options else {}
            products = {app: p for app, p in chosen.items() if p["in_stock"]}
        else:
            products = {a: m["product"] for a, m in match["per_app"].items() if m["status"] == "matched"}
        for app, p in products.items():
            offers[app] = {"product_id": p["id"], "name": p["name"], "unit_price": p["price"], "size_text": p["size_text"]}
        opt_items.append({"item_id": item["id"], "name": item["name"], "quantity": item["quantity"], "offers": offers})
    body = {"items": opt_items, "fees": found["fees"]}
    if max_apps:
        body["max_apps"] = max_apps
    return items, matches, client.post("/optimize", json=body).json()


def test_healthz(client):
    body = client.get("/healthz").json()
    assert body["status"] == "ok" and body["matcher"] == "fuzzy" and body["parse_provider"] == "rules"
    assert body["embedder"] == "local-hash" and body["confidence_threshold"] == 0.8


def test_parse_endpoint(client):
    res = client.post("/parse", json={"text": "1L amul milk, eggs, 2 maggi"})
    assert res.status_code == 200 and res.headers["X-Request-ID"]
    body = res.json()
    assert body["provider"] == "rules" and len(body["items"]) == 3
    assert body["items"][0] == {
        "id": "item-1", "raw": "1L amul milk", "name": "milk", "brand": "Amul", "quantity": 1,
        "size": {"value": 1000.0, "unit": "ml"}, "notes": None, "search_query": "Amul milk 1 L",
    }


@pytest.mark.parametrize("payload,status", [({"text": ""}, 422), ({}, 422), ({"text": "x" * 4001}, 422), ({"text": "!!! 123"}, 422)])
def test_parse_rejects_bad_input(client, payload, status):
    res = client.post("/parse", json=payload)
    assert res.status_code == status
    error = res.json()["error"]
    assert error["code"] in {"invalid_request", "http_error"} and error["message"] and error["request_id"]


def test_match_and_optimize_reject_bad_input(client):
    assert client.post("/match", json={"items": [], "candidates": {}}).status_code == 422
    bad = {"items": [{"item_id": "a", "name": "a", "offers": {"zepto": {"product_id": "p", "name": "p", "unit_price": 1}}}],
           "fees": {}}
    res = client.post("/optimize", json=bad)
    assert res.status_code == 422 and "without fees" in res.json()["error"]["message"]
    assert client.post("/optimize", content=b"not json", headers={"Content-Type": "application/json"}).status_code == 422


def test_full_pipeline_on_mock_stores(client):
    items, matches, plan = pipeline(client, SAMPLE)
    by_name = {i["name"]: m for i, m in zip(items, matches)}
    assert by_name["milk"]["needs_user"] and by_name["atta"]["status"] == "matched"
    assert by_name["hing"]["status"] == "out_of_stock" and by_name["dragonfruit"]["status"] == "not_found"

    assert plan["unfulfilled"] == ["item-8"]  # dragonfruit
    assert set(plan["assignment"]) == {f"item-{n}" for n in range(1, 8)}
    assert plan["best_single"] and plan["savings"] >= 0
    assert round(sum(c["total"] for c in plan["carts"]), 2) == plan["total"]
    for cart in plan["carts"]:
        lines = sum(line["line_total"] for line in cart["lines"])
        assert round(lines, 2) == cart["subtotal"]
        assert round(cart["subtotal"] + cart["delivery_fee"] + cart["handling_fee"] + cart["small_cart_fee"], 2) == cart["total"]
    maggi = next(line for c in plan["carts"] for line in c["lines"] if line["item_id"] == "item-3")
    assert maggi["quantity"] == 2 and maggi["line_total"] == 2 * maggi["unit_price"]
    assert plan["total"] <= min(b["total"] for b in plan["baselines"] if b["complete"])


def test_pipeline_single_app_limit_matches_baseline(client):
    _, _, plan = pipeline(client, SAMPLE, max_apps=1)
    assert len(plan["carts"]) == 1 and plan["savings"] == 0
    assert plan["carts"][0]["app"] == plan["best_single"]["app"]


def test_mock_store_shapes_differ_but_agree(client):
    z = client.get("/mock/zepto/api/v3/search", params={"query": "amul milk 1 l"}).json()
    b = client.get("/mock/blinkit/api/v1/layout/search", params={"q": "amul milk 1 l"}).json()
    i = client.post("/mock/instamart/api/instamart/search", json={"query": "amul milk 1 l"}).json()
    zp = z["layout"][0]["data"]["resolver"]["data"]["items"][0]["productResponse"]
    bp = b["response"]["snippets"][0]["data"]
    ip = i["data"]["widgets"][0]["data"][0]
    assert zp["sellingPrice"] == 6800 and zp["productVariant"]["formattedPacksize"] == "1 L"  # paise
    assert bp["normal_price"]["text"] == "₹70" and bp["variant"]["text"] == "1 ltr"
    assert bp["name"]["text"] == "Amul Taaza Homogenised Toned Milk"
    assert ip["variations"][0]["price"]["offer_price"] == 69 and ip["variations"][0]["inventory"]["in_stock"] is True
    assert client.get("/mock/zepto/api/v3/search", params={"query": "zzzz"}).json()["layout"][0]["data"]["resolver"]["data"]["items"] == []


def test_mock_search_ranking(client):
    names = [s["data"]["name"]["text"] for s in
             client.get("/mock/blinkit/api/v1/layout/search", params={"q": "milk"}).json()["response"]["snippets"]]
    assert names and all("Milk" in n for n in names[:4]) and "Cadbury Dairy Milk Chocolate" not in names[:4]
    assert client.get("/mock/blinkit/api/home").json()["response"]["snippets"]


def test_mock_cart_flow(client):
    client.get("/mock/zepto/")  # sets the session cookie
    assert client.cookies.get("cp_sid")
    client.delete("/mock/zepto/api/cart")
    one = client.post("/mock/zepto/api/cart", json={"product_id": "z-maggi-70g", "delta": 1}).json()["cart"]
    assert (one["count"], one["subtotal"], one["delivery_fee"], one["handling_fee"], one["small_cart_fee"]) == (1, 15, 30, 5, 20)
    assert one["total"] == 70
    two = client.post("/mock/zepto/api/cart", json={"product_id": "z-maggi-70g", "delta": 1}).json()["cart"]
    assert two["items"][0]["quantity"] == 2 and two["subtotal"] == 30
    big = client.post("/mock/zepto/api/cart", json={"product_id": "z-aashirvaad-atta-5kg", "delta": 1}).json()["cart"]
    assert big["subtotal"] == 275 and big["delivery_fee"] == 0 and big["small_cart_fee"] == 0 and big["total"] == 280
    assert client.get("/mock/blinkit/api/cart").json()["cart"]["count"] == 0  # carts are per store
    removed = client.post("/mock/zepto/api/cart", json={"product_id": "z-maggi-70g", "delta": -5}).json()["cart"]
    assert [i["product_id"] for i in removed["items"]] == ["z-aashirvaad-atta-5kg"]
    assert client.delete("/mock/zepto/api/cart").json()["cart"] == {
        "items": [], "count": 0, "subtotal": 0, "delivery_fee": 0.0, "handling_fee": 0.0, "small_cart_fee": 0.0, "total": 0.0}


def test_mock_cart_errors(client):
    oos = client.post("/mock/zepto/api/cart", json={"product_id": "z-catch-hing-50g", "delta": 1})
    assert oos.status_code == 409 and oos.json()["error"]["code"] == "OUT_OF_STOCK"
    missing = client.post("/mock/zepto/api/cart", json={"product_id": "nope", "delta": 1})
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "NOT_FOUND"
    assert client.post("/mock/zepto/api/cart", json={"product_id": "z-maggi-70g", "delta": 999}).status_code == 422
    assert client.get("/mock/amazon/api/cart").status_code == 404
    assert client.get("/mock/amazon/").status_code == 404


def test_mock_cart_matches_optimizer_fee_model(client):
    """The mock storefront and the optimizer must charge the same fees for the same cart."""
    _, _, plan = pipeline(client, SAMPLE)
    for cart in plan["carts"]:
        client.get(f"/mock/{cart['app']}/")
        client.delete(f"/mock/{cart['app']}/api/cart")
        store_cart = None
        for line in cart["lines"]:
            store_cart = client.post(f"/mock/{cart['app']}/api/cart",
                                     json={"product_id": line["product_id"], "delta": line["quantity"]}).json()["cart"]
        assert store_cart["total"] == cart["total"], cart["app"]
        assert store_cart["delivery_fee"] == cart["delivery_fee"]


def test_static_pages_and_cors(client):
    assert client.get("/", follow_redirects=False).headers["location"] == "/app/"
    assert client.get("/mock/blinkit/api/config").json()["fees"]["free_delivery_threshold"] == 199
    ok = client.options("/parse", headers={"Origin": "chrome-extension://" + "a" * 32, "Access-Control-Request-Method": "POST"})
    assert ok.headers["access-control-allow-origin"] == "chrome-extension://" + "a" * 32
    evil = client.options("/parse", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in evil.headers


def test_unhandled_error_is_json(client, monkeypatch):
    from fastapi.testclient import TestClient

    from cartpilot import main

    monkeypatch.setattr(main, "parse_list", lambda *a, **k: 1 / 0)
    res = TestClient(main.app, raise_server_exceptions=False).post("/parse", json={"text": "milk"})
    assert res.status_code == 500 and res.json()["error"]["code"] == "internal_error"
