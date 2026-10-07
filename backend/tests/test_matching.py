import dataclasses
import json

import httpx
import pytest

from cartpilot.config import get_settings
from cartpilot.embeddings import LocalHashEmbedder, cosine
from cartpilot.matching import FuzzyChooser, JevChooser, build_variants, fuzzy_score, match_items, shortlist, tokens
from cartpilot.mockstores import CollectRequest, collect
from cartpilot.models import GroceryItem, MatchRequest, Product
from cartpilot.parsing import parse_with_rules


def P(name, price=10, app="zepto", size=None, brand=None, in_stock=True, rank=None, pid=None):
    return Product(id=pid or f"{app}-{name}-{size}", app=app, name=name, brand=brand, size_text=size, price=price,
                   in_stock=in_stock, rank=rank)


def run(text):
    items = parse_with_rules(text)
    found = collect(CollectRequest(items=items))
    result = match_items(MatchRequest(items=items, candidates=found.candidates))
    return items, {m.item_id: m for m in result.matches}, result


def test_tokens():
    assert tokens("Maggi 2-Minute Masala Noodles 70 g") == ["maggi", "minute", "masala", "noodle"]
    assert tokens("Lay's Classic Salted Potato Chips") == ["lay", "classic", "salted", "potato", "chip"]
    assert tokens("Tomatoes 1kg Pack of 2") == ["tomato"]
    assert tokens(None) == []


def test_fuzzy_score_ordering():
    item = GroceryItem(id="i", name="milk", brand="Amul", size={"value": 1000, "unit": "ml"})
    right = fuzzy_score(item, P("Amul Taaza Toned Milk", size="1 L", brand="Amul"))
    wrong_size = fuzzy_score(item, P("Amul Taaza Toned Milk", size="500 ml", brand="Amul"))
    wrong_brand = fuzzy_score(item, P("Mother Dairy Toned Milk", size="1 L", brand="Mother Dairy"))
    unrelated = fuzzy_score(item, P("Amul Butter", size="100 g", brand="Amul"))
    assert right > 0.9
    assert right > wrong_size > unrelated
    assert right > wrong_brand
    assert unrelated < 0.5


def test_fuzzy_handles_typos():
    item = GroceryItem(id="i", name="aashirvad atta")
    assert fuzzy_score(item, P("Aashirvaad Shudh Chakki Atta", brand="Aashirvaad")) > 0.8


def test_local_embedder_is_deterministic_and_sensible():
    e = LocalHashEmbedder()
    a, b, c = e.embed(["amul milk 1 l", "Amul Taaza Toned Milk 1 L", "Surf Excel Detergent Powder"])
    assert e.embed(["amul milk 1 l"])[0] == a
    assert abs(cosine(a, a) - 1) < 1e-9
    assert cosine(a, b) > cosine(a, c)
    assert e.embed([""])[0] == [0.0] * e.dim


def test_shortlist_keeps_top_k_and_the_right_product():
    item = GroceryItem(id="i", name="milk", brand="Amul", size={"value": 1000, "unit": "ml"})
    noise = [P(f"Surf Excel Detergent {n}", rank=n) for n in range(12)]
    target = P("Amul Taaza Toned Milk", size="1 L", brand="Amul", rank=12)
    picked = shortlist(item, noise + [target], LocalHashEmbedder(), 5)
    assert len(picked) == 5 and picked[0] is target
    few = [target]
    assert shortlist(item, few, LocalHashEmbedder(), 5) == few


def test_fuzzy_chooser_none_of_these():
    chooser = FuzzyChooser()
    item = GroceryItem(id="i", name="dragonfruit")
    assert chooser.choose(item, []).index is None
    choice = chooser.choose(item, [P("Amul Butter"), P("Onion")])
    assert choice.index is None and choice.confidence > 0.8


def test_fuzzy_chooser_confident_only_with_clear_winner():
    chooser = FuzzyChooser()
    item = GroceryItem(id="i", name="eggs")
    ambiguous = chooser.choose(item, [P("Table White Eggs", size="6 pcs"), P("Table White Eggs", size="12 pcs")])
    assert ambiguous.index is not None and ambiguous.confidence < 0.8
    sized = GroceryItem(id="i", name="eggs", size={"value": 12, "unit": "pcs"})
    clear = chooser.choose(sized, [P("Table White Eggs", size="6 pcs"), P("Table White Eggs", size="12 pcs")])
    assert clear.index == 1 and clear.confidence >= 0.8


def test_end_to_end_statuses_on_fixtures():
    items, by_id, result = run("1L amul milk, eggs, 2 maggi, aashirvaad atta 5kg, onion 1kg, catch hing, dragonfruit")
    assert result.matcher == "fuzzy" and result.threshold == 0.8
    status = {i.name: by_id[i.id] for i in items}

    assert status["milk"].status == "needs_user" and status["milk"].needs_user
    labels = [v.label for v in status["milk"].variants]
    assert labels[:2] == ["Amul Taaza Toned Milk", "Amul Gold Full Cream Milk"]
    assert all(set(v.per_app) == {"zepto", "blinkit", "instamart"} for v in status["milk"].variants)

    assert status["eggs"].needs_user and len(status["eggs"].variants) == 4
    assert status["maggi"].needs_user and len(status["maggi"].variants) >= 4

    atta = status["atta"]
    assert atta.status == "matched" and not atta.needs_user and atta.confidence >= 0.8
    assert {m.product.id for m in atta.per_app.values()} == {
        "z-aashirvaad-atta-5kg", "b-aashirvaad-atta-5kg", "i-aashirvaad-atta-5kg"}

    assert status["onion"].status == "matched"
    assert {m.product.name for m in status["onion"].per_app.values()} == {"Onion", "Onion (Pyaz)", "Fresh Onion"}

    hing = status["hing"]
    assert hing.status == "out_of_stock" and hing.needs_user
    assert all(m.status == "out_of_stock" for m in hing.per_app.values())
    assert [s.label for s in hing.substitutes] == ["Everest Compounded Hing"]
    assert hing.substitutes[0].kind == "substitute" and hing.substitutes[0].different_brand
    assert all(p.in_stock for p in hing.substitutes[0].per_app.values())

    missing = status["dragonfruit"]
    assert missing.status == "not_found" and not missing.needs_user and missing.variants == []


def test_every_needs_user_item_has_options():
    _, by_id, _ = run("milk, bread, rice, dal, tea, coffee, salt, oil, butter, curd, biscuits, noodles, tomato")
    for m in by_id.values():
        if m.needs_user:
            assert m.variants or m.substitutes, m.item_id
        for v in m.variants:
            assert v.per_app and len({p.app for p in v.per_app.values()}) == len(v.per_app)


def test_missing_on_one_app_is_not_found_there():
    _, by_id, _ = run("mother dairy milk 1L")
    m = next(iter(by_id.values()))
    assert m.status == "matched"
    assert m.per_app["instamart"].status == "not_found"
    assert m.per_app["zepto"].product.id == "z-md-toned-1l"


def test_variants_cluster_same_product_across_apps():
    a = P("Amul Taaza Toned Milk", app="zepto", size="1 L", brand="Amul")
    b = P("Amul Taaza Homogenised Toned Milk", app="blinkit", size="1 ltr", brand="Amul")
    c = P("Amul Gold Full Cream Milk", app="blinkit", size="1 L", brand="Amul", pid="gold")
    d = P("Amul Taaza Toned Milk", app="instamart", size="500 ml", brand="Amul")
    variants = build_variants([(0.9, a), (0.9, b), (0.8, c), (0.7, d)])
    assert [sorted(v.per_app) for v in variants] == [["blinkit", "zepto"], ["blinkit"], ["instamart"]]
    assert len({v.key for v in variants}) == 3


def _jev(handler, max_retries=0):
    settings = dataclasses.replace(get_settings(), jev_api_key="k", matcher_name="jev")
    client = httpx.Client(base_url="https://jev.test/api/v1", transport=httpx.MockTransport(handler))
    return JevChooser(settings, client=client, max_retries=max_retries)


def _reply(payload):
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(payload)}}]})


def test_jev_chooser_sends_none_option_and_maps_choice():
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        seen["url"] = str(request.url)
        return _reply({"choice": 2, "confidence": 0.93, "reason": "exact"})

    chooser = _jev(handler)
    item = GroceryItem(id="i", name="milk", brand="Amul")
    choice = chooser.choose(item, [P("Amul Butter"), P("Amul Taaza Toned Milk", size="1 L")])
    assert (choice.index, choice.confidence) == (1, 0.93)
    assert seen["url"].endswith("/chat/completions")
    assert seen["body"]["model"] == "typesafe/jev-1.13"
    prompt = seen["body"]["messages"][1]["content"]
    assert "0. NONE OF THESE" in prompt and "2. Amul Taaza Toned Milk" in prompt


def test_jev_none_of_these_and_low_confidence():
    item = GroceryItem(id="i", name="eggs")
    options = [P("Table White Eggs", size="6 pcs"), P("Table White Eggs", size="12 pcs")]
    assert _jev(lambda r: _reply({"choice": 0, "confidence": 0.9})).choose(item, options).index is None

    settings = dataclasses.replace(get_settings(), jev_api_key="k", matcher_name="jev")
    chooser = _jev(lambda r: _reply({"choice": 1, "confidence": 0.6}))
    request = MatchRequest(items=[item], candidates={"zepto": {"i": options}})
    result = match_items(request, settings=settings, chooser=chooser)
    match = result.matches[0]
    assert result.matcher == "jev" and match.needs_user and match.per_app["zepto"].status == "needs_user"
    assert len(match.variants) == 2


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(500, text="boom"),
        lambda r: _reply({"choice": 99, "confidence": 1}),
        lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "sorry, no json"}}]}),
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("offline")),
    ],
)
def test_jev_failures_fall_back_to_fuzzy(handler):
    item = GroceryItem(id="i", name="onion")
    options = [P("Onion", size="1 kg"), P("Amul Butter")]
    assert _jev(handler).choose(item, options) == FuzzyChooser().choose(item, options)


def test_substitute_check_noul_and_fallback():
    item = GroceryItem(id="i", name="hing", brand="Catch")
    wanted = P("Catch Compounded Hing", size="50 g", brand="Catch", in_stock=False)
    good = P("Everest Compounded Hing", size="50 g", brand="Everest")
    bad_kind = P("Everest Turmeric Powder", size="50 g", brand="Everest")
    bad_size = P("Everest Compounded Hing", size="500 g", brand="Everest")
    fuzzy = FuzzyChooser()
    assert fuzzy.acceptable_substitute(item, wanted, good)
    assert not fuzzy.acceptable_substitute(item, wanted, bad_kind)
    assert not fuzzy.acceptable_substitute(item, wanted, bad_size)

    assert _jev(lambda r: _reply({"answer": False})).acceptable_substitute(item, wanted, good) is False
    assert _jev(lambda r: _reply({"answer": True})).acceptable_substitute(item, wanted, bad_kind) is True
    assert _jev(lambda r: httpx.Response(503)).acceptable_substitute(item, wanted, good) is True


def test_product_size_is_derived():
    assert P("Amul Milk", size="1 ltr").size.value == 1000
    assert P("Amul Milk 500 ml").size.value == 500
    assert P("Amul Milk").size is None


def test_groq_key_alone_runs_the_matcher_on_groq(monkeypatch):
    from cartpilot import config

    monkeypatch.setenv("GROQ_API_KEY", "gk")
    monkeypatch.setenv("JEV_API_KEY", "")
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    config.get_settings.cache_clear()
    try:
        s = config.get_settings()
        assert (s.matcher_name, s.jev_base_url, s.jev_model) == ("groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-120b")
        assert JevChooser(s, client=httpx.Client(transport=httpx.MockTransport(lambda r: _reply({})))).name == "groq"
        monkeypatch.setenv("JEV_API_KEY", "jk")
        config.get_settings.cache_clear()
        assert config.get_settings().matcher_name == "jev"  # a real Jev key still wins
    finally:
        monkeypatch.undo()
        config.get_settings.cache_clear()


# ---------------------------------------------------------------- call budget


def _three_apps(names_sizes):
    return {app: [P(n, app=app, size=sz, rank=i) for i, (n, sz) in enumerate(names_sizes)] for app in ("zepto", "blinkit", "instamart")}


def test_one_request_per_item_covers_every_store():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content)["messages"][1]["content"])
        return _reply({app: {"choice": 2, "confidence": 0.95, "reason": "12 pack"} for app in ("zepto", "blinkit", "instamart")})

    chooser = _jev(handler)
    item = GroceryItem(id="i", name="eggs")
    options = _three_apps([("Table White Eggs", "6 pcs"), ("Table White Eggs", "12 pcs")])
    result = match_items(MatchRequest(items=[item], candidates={a: {"i": o} for a, o in options.items()}),
                         settings=dataclasses.replace(get_settings(), jev_api_key="k", matcher_name="jev"), chooser=chooser)
    assert chooser.calls == 1 and len(seen) == 1
    assert all(f"Store {a}:" in seen[0] for a in options) and seen[0].count("0. NONE OF THESE") == 3
    match = result.matches[0]
    assert match.status == "matched" and not match.needs_user
    assert {m.product.size_text for m in match.per_app.values()} == {"12 pcs"}


def test_model_is_not_asked_when_fuzzy_is_already_sure():
    chooser = _jev(lambda r: (_ for _ in ()).throw(AssertionError("should not be called")))
    item = GroceryItem(id="i", name="onion", size={"value": 1000, "unit": "g"})
    options = _three_apps([("Onion", "1 kg"), ("Amul Butter", "100 g")])
    result = match_items(MatchRequest(items=[item], candidates={a: {"i": o} for a, o in options.items()}),
                         settings=dataclasses.replace(get_settings(), jev_api_key="k", matcher_name="jev"), chooser=chooser)
    assert chooser.calls == 0 and result.matches[0].status == "matched"


def test_store_missing_from_the_reply_falls_back_for_that_store_only():
    chooser = _jev(lambda r: _reply({"zepto": {"choice": 1, "confidence": 0.9}, "blinkit": {"choice": 99, "confidence": 1}}))
    item = GroceryItem(id="i", name="eggs")
    options = _three_apps([("Table White Eggs", "6 pcs"), ("Table White Eggs", "12 pcs")])
    choices = chooser.choose_many(item, options)
    assert (choices["zepto"].index, choices["zepto"].confidence) == (0, 0.9)
    fuzzy = FuzzyChooser().choose(item, options["blinkit"])
    assert choices["blinkit"] == fuzzy and choices["instamart"] == FuzzyChooser().choose(item, options["instamart"])
    assert chooser.choose_many(item, {"zepto": []})["zepto"].index is None


def test_rate_limit_is_retried_then_answer_is_cached(monkeypatch):
    from cartpilot import matching

    naps = []
    monkeypatch.setattr(matching.time, "sleep", naps.append)
    replies = [httpx.Response(429, headers={"retry-after": "30"}), _reply({"choice": 1, "confidence": 0.9})]
    chooser = _jev(lambda r: replies.pop(0), max_retries=2)
    item = GroceryItem(id="i", name="eggs")
    options = [P("Table White Eggs", size="6 pcs"), P("Table White Eggs", size="12 pcs")]
    assert chooser.choose(item, options).index == 0
    assert chooser.calls == 2 and naps == [4.0]  # waited, but never longer than 4 s
    assert chooser.choose(item, options).index == 0 and chooser.calls == 2  # second time: no request at all


def test_gives_up_after_retries_and_uses_fuzzy(monkeypatch):
    from cartpilot import matching

    monkeypatch.setattr(matching.time, "sleep", lambda s: None)
    chooser = _jev(lambda r: httpx.Response(429), max_retries=2)
    item = GroceryItem(id="i", name="onion")
    options = [P("Onion", size="1 kg"), P("Amul Butter")]
    assert chooser.choose(item, options) == FuzzyChooser().choose(item, options)
    assert chooser.calls == 3


def test_substitutes_are_checked_in_one_request():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content)["messages"][1]["content"])
        return _reply({"acceptable": [2]})

    chooser = _jev(handler)
    item = GroceryItem(id="i", name="hing", brand="Catch")
    wanted = P("Catch Compounded Hing", size="50 g", brand="Catch", in_stock=False)
    a, b = P("Everest Compounded Hing", size="50 g", brand="Everest"), P("MDH Hing", size="50 g", brand="MDH")
    assert chooser.filter_substitutes(item, wanted, [a, b]) == [False, True]
    assert chooser.calls == 1 and "1. Everest Compounded Hing" in bodies[0] and "2. MDH Hing" in bodies[0]
    assert chooser.filter_substitutes(item, wanted, []) == []
    assert _jev(lambda r: httpx.Response(500)).filter_substitutes(item, wanted, [a, b]) == [True, True]
