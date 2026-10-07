import dataclasses

import pytest

from cartpilot import parsing
from cartpilot.config import get_settings
from cartpilot.models import Size
from cartpilot.parsing import parse_list, parse_with_rules
from cartpilot.units import format_size, parse_size, same_size, size_similarity


@pytest.mark.parametrize(
    "text,value,unit",
    [
        ("1L", 1000, "ml"), ("1 ltr", 1000, "ml"), ("500 ml", 500, "ml"), ("2kg", 2000, "g"), ("250 gm", 250, "g"),
        ("1.5 kg", 1500, "g"), ("12 pcs", 12, "pcs"), ("4 x 125 g", 500, "g"), ("1 dozen", 12, "pcs"),
        ("dozen", 12, "pcs"), ("half dozen", 6, "pcs"), ("pack of 6", 6, "pcs"), ("Amul Milk 1 L Pouch", 1000, "ml"),
    ],
)
def test_parse_size(text, value, unit):
    size = parse_size(text)
    assert size == Size(value=value, unit=unit)


@pytest.mark.parametrize("text", ["", None, "maggi", "6 lemons", "2 maggi", "top 10 grapes"])
def test_parse_size_none(text):
    assert parse_size(text) is None


def test_size_helpers():
    assert format_size(Size(value=1000, unit="ml")) == "1 L"
    assert format_size(Size(value=1500, unit="g")) == "1.5 kg"
    assert format_size(Size(value=70, unit="g")) == "70 g"
    assert format_size(None) == ""
    assert size_similarity(Size(value=500, unit="ml"), Size(value=1000, unit="ml")) == 0.5
    assert size_similarity(Size(value=500, unit="ml"), Size(value=500, unit="g")) == 0.0
    assert size_similarity(None, Size(value=1, unit="g")) is None
    assert same_size(Size(value=1000, unit="g"), Size(value=990, unit="g"))
    assert not same_size(Size(value=1000, unit="g"), Size(value=500, unit="g"))
    assert same_size(None, None) and not same_size(None, Size(value=1, unit="g"))


def _one(text):
    items = parse_with_rules(text)
    assert len(items) == 1, items
    return items[0]


def test_spec_example():
    items = parse_with_rules("1L amul milk, eggs, 2 maggi")
    assert [(i.name, i.brand, i.quantity, i.size) for i in items] == [
        ("milk", "Amul", 1, Size(value=1000, unit="ml")),
        ("eggs", None, 1, None),
        ("maggi", "Maggi", 2, None),
    ]
    assert [i.id for i in items] == ["item-1", "item-2", "item-3"]
    assert items[0].search_query == "Amul milk 1 L"
    assert items[2].search_query == "maggi"


@pytest.mark.parametrize(
    "text,name,brand,qty,size",
    [
        ("2 kg atta", "atta", None, 1, Size(value=2000, unit="g")),
        ("aashirvaad atta 5kg x2", "atta", "Aashirvaad", 2, Size(value=5000, unit="g")),
        ("3 packets lays", "lay's", "Lay's", 3, None),
        ("2 x coke", "coca-cola", "Coca-Cola", 2, None),
        ("12 eggs", "eggs", None, 1, Size(value=12, unit="pcs")),
        ("a dozen bananas", "bananas", None, 1, Size(value=12, unit="pcs")),
        ("Mother Dairy curd 400g", "curd", "Mother Dairy", 1, Size(value=400, unit="g")),
        ("- tata salt", "salt", "Tata", 1, None),
        ("1.5 kg rice", "rice", None, 1, Size(value=1500, unit="g")),
        ("2 bottles of bisleri 1l", "bisleri", "Bisleri", 2, Size(value=1000, unit="ml")),
        ("99 onion", "onion", None, 50, None),
    ],
)
def test_rule_fragments(text, name, brand, qty, size):
    item = _one(text)
    assert (item.name, item.brand, item.quantity, item.size) == (name, brand, qty, size)


def test_separators_and_junk():
    items = parse_with_rules("milk\nbread; butter and jam & ghee,, ,123, !!!")
    assert [i.name for i in items] == ["milk", "bread", "butter", "jam", "ghee"]
    assert parse_with_rules("  \n ,, ") == []


def test_numbered_list_is_not_quantity():
    items = parse_with_rules("1. milk\n2. bread\n3) 2 maggi")
    assert [(i.name, i.quantity) for i in items] == [("milk", 1), ("bread", 1), ("maggi", 2)]


def test_item_cap():
    assert len(parse_with_rules(",".join(f"thing{chr(97 + i % 26)}{chr(97 + i // 26)}" for i in range(200)))) == 60


def _settings(**kw):
    return dataclasses.replace(get_settings(), **kw)


def test_parse_list_uses_rules_without_key():
    items, provider, warnings = parse_list("eggs", _settings(parse_provider="auto", anthropic_api_key=None))
    assert provider == "rules" and warnings == [] and items[0].name == "eggs"
    assert parsing.resolve_provider(_settings(parse_provider="anthropic", anthropic_api_key=None)) == "rules"
    assert parsing.resolve_provider(_settings(parse_provider="auto", anthropic_api_key="k")) == "anthropic"
    assert parsing.resolve_provider(_settings(parse_provider="rules", anthropic_api_key="k")) == "rules"


def test_parse_list_falls_back_when_provider_fails(monkeypatch):
    def boom(text, settings=None):
        raise RuntimeError("network down")

    monkeypatch.setitem(parsing.PROVIDERS, "anthropic", boom)
    items, provider, warnings = parse_list("2 maggi", _settings(parse_provider="anthropic", anthropic_api_key="k"))
    assert provider == "rules" and items[0].quantity == 2
    assert warnings and "built-in parser" in warnings[0]


def test_parse_list_falls_back_when_provider_returns_nothing(monkeypatch):
    monkeypatch.setitem(parsing.PROVIDERS, "anthropic", lambda text, settings=None: [])
    items, provider, warnings = parse_list("eggs", _settings(parse_provider="anthropic", anthropic_api_key="k"))
    assert provider == "rules" and len(items) == 1 and warnings


def test_anthropic_provider_request_and_conversion(monkeypatch):
    """The provider must call messages.parse with the Pydantic schema and convert units."""
    import anthropic

    captured = {}

    class FakeMessages:
        def parse(self, **kwargs):
            captured.update(kwargs)
            parsed = parsing._LLMList(
                items=[
                    parsing._LLMItem(name="Milk", brand="Amul", quantity=1, size_value=1, size_unit="l", notes="full cream"),
                    parsing._LLMItem(name="eggs", brand=None, quantity=0, size_value=None, size_unit=None, notes=None),
                    parsing._LLMItem(name="  ", brand=None, quantity=1, size_value=None, size_unit=None, notes=None),
                ]
            )
            return type("R", (), {"parsed_output": parsed, "stop_reason": "end_turn"})()

    class FakeClient:
        def __init__(self, **kwargs):
            captured["client_kwargs"] = kwargs
            self.messages = FakeMessages()

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    items, provider, warnings = parse_list("1L amul milk, eggs", _settings(parse_provider="anthropic", anthropic_api_key="k"))
    assert provider == "anthropic" and warnings == []
    assert captured["model"] == "claude-haiku-4-5"
    assert captured["output_format"] is parsing._LLMList
    assert "1L amul milk, eggs" in captured["messages"][0]["content"]
    assert captured["client_kwargs"]["api_key"] == "k"
    assert [(i.name, i.brand, i.quantity, i.size, i.notes) for i in items] == [
        ("milk", "Amul", 1, Size(value=1000, unit="ml"), "full cream"),
        ("eggs", None, 1, None, None),
    ]


def test_real_sdk_has_the_method_we_call():
    import anthropic

    assert callable(getattr(anthropic.Anthropic(api_key="x").messages, "parse", None))


def test_groq_provider_request_and_validation(monkeypatch):
    import httpx

    seen = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen.update(url=url, headers=headers, body=json)
        content = '{"items": [{"name": "Milk", "brand": "Amul", "quantity": 1, "size_value": 1, "size_unit": "l", "notes": null},' \
                  ' {"name": "maggi", "brand": "Maggi", "quantity": 2, "size_value": null, "size_unit": null, "notes": null}]}'
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(parsing.httpx, "post", fake_post)
    settings = _settings(parse_provider="auto", groq_api_key="gk", anthropic_api_key="ak")
    assert parsing.resolve_provider(settings) == "groq"  # Groq wins when both keys are set
    items, provider, warnings = parse_list("1L amul milk, 2 maggi", settings)
    assert provider == "groq" and warnings == []
    assert seen["url"] == "https://api.groq.com/openai/v1/chat/completions"
    assert seen["headers"] == {"Authorization": "Bearer gk"}
    assert seen["body"]["model"] == "openai/gpt-oss-120b" and seen["body"]["response_format"] == {"type": "json_object"}
    assert "size_unit" in seen["body"]["messages"][0]["content"]
    assert [(i.name, i.brand, i.quantity, i.size) for i in items] == [
        ("milk", "Amul", 1, Size(value=1000, unit="ml")), ("maggi", "Maggi", 2, None)]


@pytest.mark.parametrize("content", ["not json", '{"items": [{"name": "x"}]}', '{"wrong": []}'])
def test_groq_bad_reply_falls_back_to_rules(monkeypatch, content):
    import httpx

    monkeypatch.setattr(parsing.httpx, "post", lambda url, **kw: httpx.Response(
        200, json={"choices": [{"message": {"content": content}}]}, request=httpx.Request("POST", url)))
    items, provider, warnings = parse_list("2 maggi", _settings(parse_provider="groq", groq_api_key="gk"))
    assert provider == "rules" and items[0].quantity == 2 and warnings


def test_groq_without_key_uses_rules():
    assert parsing.resolve_provider(_settings(parse_provider="groq", groq_api_key=None)) == "rules"
    assert parsing.resolve_provider(_settings(parse_provider="anthropic", groq_api_key="gk", anthropic_api_key=None)) == "rules"
