"""Offline mock stores.

Three fake storefronts backed by one fixture catalogue. Each one answers its search
API in a different (invented) JSON shape, so the extension's per-app ``normalize()``
functions are exercised for real. Nothing here talks to the internet.
"""

from __future__ import annotations

import json
import re
import secrets
import threading
from functools import lru_cache
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from .config import FIXTURES_DIR, STATIC_DIR, STORES
from .matching import tokens
from .models import FeeConfig, GroceryItem, Product
from .units import parse_size, same_size

router = APIRouter(prefix="/mock", tags=["mock stores"])

SESSION_COOKIE = "cp_sid"
MAX_RESULTS = 12
MAX_QTY = 20


@lru_cache
def store_settings() -> dict[str, dict[str, Any]]:
    data = json.loads((FIXTURES_DIR / "stores.json").read_text("utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


@lru_cache
def catalog() -> dict[str, list[dict[str, Any]]]:
    """Per-store listings: {store: [listing, ...]}."""
    raw = json.loads((FIXTURES_DIR / "catalog.json").read_text("utf-8"))["products"]
    stores = store_settings()
    out: dict[str, list[dict[str, Any]]] = {s: [] for s in STORES}
    for p in raw:
        for store, listing in p["apps"].items():
            name = listing.get("name", p["name"])
            out[store].append(
                {
                    "id": f"{stores[store]['prefix']}-{p['id']}",
                    "name": name,
                    "brand": p["brand"],
                    "size": p["size"],
                    "category": p["category"],
                    "emoji": p["emoji"],
                    "mrp": p["mrp"],
                    "price": listing["price"],
                    "in_stock": listing["in_stock"],
                    "_tokens": set(tokens(name)) | set(tokens(p["brand"])),
                    "_keywords": set(tokens(" ".join(p["keywords"]))),
                    "_size": parse_size(p["size"]),
                }
            )
    return out


def fees_for(store: str) -> FeeConfig:
    return FeeConfig(**store_settings()[store]["fees"])


def _check(store: str) -> str:
    if store not in STORES:
        raise HTTPException(status_code=404, detail=f"unknown store {store!r}")
    return store


def search(store: str, query: str) -> list[dict[str, Any]]:
    """Rank listings the way a storefront would: keyword hits first, then name overlap."""
    listings = catalog()[store]
    q = tokens(query)
    if not q:
        return []
    wanted_size = parse_size(query)
    scored: list[tuple[float, int, dict[str, Any]]] = []
    for index, listing in enumerate(listings):
        pool = listing["_tokens"] | listing["_keywords"]
        hits = sum(1 for t in q if t in pool)
        if not hits:
            continue
        score = hits / len(q)
        if any(t in listing["_keywords"] for t in q):
            score += 0.3
        if score < 0.75:
            continue
        if wanted_size is not None and same_size(wanted_size, listing["_size"]):
            score += 0.2
        scored.append((-score, index, listing))
    scored.sort(key=lambda s: (s[0], s[1]))
    return [listing for _, _, listing in scored[:MAX_RESULTS]]


def featured(store: str) -> list[dict[str, Any]]:
    listings = catalog()[store]
    seen: set[str] = set()
    picks = []
    for listing in listings:
        if listing["category"] not in seen:
            seen.add(listing["category"])
            picks.append(listing)
    return (picks + [x for x in listings if x not in picks])[:MAX_RESULTS]


# ------------------------------------------------- store-specific response shapes
# These shapes are made up for the demo. They are NOT the real apps' API formats.


def shape_zepto(listings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "layout": [
            {
                "widgetId": "SEARCHED_PRODUCTS",
                "data": {
                    "resolver": {
                        "data": {
                            "items": [
                                {
                                    "productResponse": {
                                        "id": x["id"],
                                        "product": {"name": x["name"], "brand": x["brand"]},
                                        "productVariant": {"formattedPacksize": x["size"], "mrp": x["mrp"] * 100},
                                        "sellingPrice": x["price"] * 100,  # paise
                                        "outOfStock": not x["in_stock"],
                                        "meta": {"emoji": x["emoji"]},
                                    }
                                }
                                for x in listings
                            ]
                        }
                    }
                },
            }
        ]
    }


def shape_blinkit(listings: list[dict[str, Any]]) -> dict[str, Any]:
    def variant(size: str) -> str:
        return re.sub(r"\bL\b", "ltr", size)

    return {
        "response": {
            "snippets": [
                {
                    "widget_type": "product_card_snippet",
                    "data": {
                        "identity": {"id": x["id"]},
                        "name": {"text": x["name"]},
                        "brand_name": {"text": x["brand"] or ""},
                        "variant": {"text": variant(x["size"])},
                        "normal_price": {"text": f"₹{x['price']}"},
                        "mrp": {"text": f"₹{x['mrp']}"},
                        "is_sold_out": not x["in_stock"],
                        "image": {"emoji": x["emoji"]},
                    },
                }
                for x in listings
            ]
        }
    }


def shape_instamart(listings: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "data": {
            "widgets": [
                {
                    "type": "PRODUCT_LIST",
                    "data": [
                        {
                            "product_id": x["id"],
                            "display_name": x["name"],
                            "brand": x["brand"],
                            "emoji": x["emoji"],
                            "variations": [
                                {
                                    "id": f"{x['id']}-v1",
                                    "quantity": x["size"],
                                    "price": {"mrp": x["mrp"], "offer_price": x["price"]},
                                    "inventory": {"in_stock": x["in_stock"]},
                                }
                            ],
                        }
                        for x in listings
                    ],
                }
            ]
        }
    }


SHAPES = {"zepto": shape_zepto, "blinkit": shape_blinkit, "instamart": shape_instamart}


def to_product(store: str, listing: dict[str, Any], rank: int) -> Product:
    return Product(
        id=listing["id"], app=store, name=listing["name"], brand=listing["brand"], size_text=listing["size"],
        price=listing["price"], mrp=listing["mrp"], in_stock=listing["in_stock"], image=listing["emoji"], rank=rank,
    )


# ------------------------------------------------- search endpoints


@router.get("/zepto/api/v3/search")
def zepto_search(query: str = Query("", max_length=200)) -> dict[str, Any]:
    return shape_zepto(search("zepto", query))


@router.get("/blinkit/api/v1/layout/search")
def blinkit_search(q: str = Query("", max_length=200)) -> dict[str, Any]:
    return shape_blinkit(search("blinkit", q))


class _InstamartSearch(BaseModel):
    query: str = Field(default="", max_length=200)


@router.post("/instamart/api/instamart/search")
def instamart_search(body: _InstamartSearch) -> dict[str, Any]:
    return shape_instamart(search("instamart", body.query))


@router.get("/{store}/api/home")
def home(store: str) -> dict[str, Any]:
    return SHAPES[_check(store)](featured(store))


@router.get("/{store}/api/config")
def config(store: str) -> dict[str, Any]:
    s = store_settings()[_check(store)]
    return {"store": store, "label": s["label"], "eta_minutes": s["eta_minutes"], "fees": s["fees"]}


# ------------------------------------------------- cart (in memory, per browser session)

_carts: dict[tuple[str, str], dict[str, int]] = {}
_lock = threading.Lock()


def _session(request: Request) -> str:
    return request.cookies.get(SESSION_COOKIE) or "anonymous"


def _cart_view(store: str, lines: dict[str, int]) -> dict[str, Any]:
    by_id = {x["id"]: x for x in catalog()[store]}
    items = [
        {
            "product_id": pid, "name": by_id[pid]["name"], "size": by_id[pid]["size"], "emoji": by_id[pid]["emoji"],
            "quantity": qty, "unit_price": by_id[pid]["price"], "line_total": by_id[pid]["price"] * qty,
        }
        for pid, qty in lines.items()
    ]
    subtotal = sum(i["line_total"] for i in items)
    fees = fees_for(store)
    delivery = handling = small = 0.0
    if items:
        free = fees.free_delivery_threshold is not None and subtotal >= fees.free_delivery_threshold
        delivery = 0.0 if free else fees.delivery_fee
        handling = fees.handling_fee
        small = fees.small_cart_fee if subtotal < fees.small_cart_threshold else 0.0
    return {
        "cart": {
            "items": items,
            "count": sum(i["quantity"] for i in items),
            "subtotal": subtotal,
            "delivery_fee": delivery,
            "handling_fee": handling,
            "small_cart_fee": small,
            "total": subtotal + delivery + handling + small,
        }
    }


class _CartChange(BaseModel):
    product_id: str = Field(max_length=200)
    delta: int = Field(ge=-MAX_QTY, le=MAX_QTY)


@router.get("/{store}/api/cart")
def get_cart(store: str, request: Request) -> dict[str, Any]:
    with _lock:
        return _cart_view(_check(store), dict(_carts.get((store, _session(request)), {})))


@router.post("/{store}/api/cart")
def change_cart(store: str, request: Request, change: _CartChange = Body(...)) -> Any:
    _check(store)
    listing = next((x for x in catalog()[store] if x["id"] == change.product_id), None)
    if listing is None:
        return JSONResponse(status_code=404, content={"error": {"code": "NOT_FOUND", "message": "No such product."}})
    if change.delta > 0 and not listing["in_stock"]:
        return JSONResponse(
            status_code=409, content={"error": {"code": "OUT_OF_STOCK", "message": f"{listing['name']} is out of stock."}}
        )
    with _lock:
        lines = _carts.setdefault((store, _session(request)), {})
        qty = max(0, min(MAX_QTY, lines.get(change.product_id, 0) + change.delta))
        if qty:
            lines[change.product_id] = qty
        else:
            lines.pop(change.product_id, None)
        return _cart_view(store, dict(lines))


@router.delete("/{store}/api/cart")
def clear_cart(store: str, request: Request) -> dict[str, Any]:
    with _lock:
        _carts.pop((_check(store), _session(request)), None)
    return _cart_view(store, {})


# ------------------------------------------------- server-side mock adapter


class CollectRequest(BaseModel):
    items: list[GroceryItem] = Field(min_length=1, max_length=60)


class CollectResponse(BaseModel):
    candidates: dict[str, dict[str, list[Product]]]
    fees: dict[str, FeeConfig]


@router.post("/collect", response_model=CollectResponse)
def collect(body: CollectRequest) -> CollectResponse:
    """What the extension would gather from the three mock stores, without a browser."""
    return CollectResponse(
        candidates={
            store: {
                item.id: [to_product(store, x, rank) for rank, x in enumerate(search(store, item.search_query))]
                for item in body.items
            }
            for store in STORES
        },
        fees={store: fees_for(store) for store in STORES},
    )


# ------------------------------------------------- storefront page


@router.get("/{store}/", response_class=HTMLResponse)
def storefront(store: str, request: Request, response: Response) -> HTMLResponse:
    s = store_settings()[_check(store)]
    html = (STATIC_DIR / "mock" / "store.html").read_text("utf-8")
    html = html.replace("{{STORE}}", store).replace("{{LABEL}}", s["label"]).replace("{{ETA}}", str(s["eta_minutes"]))
    page = HTMLResponse(html, headers={"Cache-Control": "no-store"})
    if not request.cookies.get(SESSION_COOKIE):
        page.set_cookie(SESSION_COOKIE, secrets.token_urlsafe(12), httponly=True, samesite="lax")
    return page
