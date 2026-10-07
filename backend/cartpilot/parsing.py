"""Free text -> typed grocery items.

Everything goes through :func:`parse_list`. Providers are swappable: add a function
to ``PROVIDERS`` and select it with ``CARTPILOT_PARSE_PROVIDER``.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from typing import Literal

import httpx
from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .models import MAX_ITEMS, GroceryItem, Size
from .units import find_size

log = logging.getLogger("cartpilot.parse")

# Longest names first so "mother dairy" wins over "dairy".
KNOWN_BRANDS = sorted(
    [
        "Amul", "Mother Dairy", "Nestle", "Maggi", "Tata Sampann", "Tata Tea", "Tata", "Aashirvaad",
        "Fortune", "Saffola", "Britannia", "Parle-G", "Parle", "Haldiram's", "Haldiram", "Everest",
        "MDH", "Catch", "India Gate", "Daawat", "Madhur", "Sunfeast", "Yippee", "Kissan", "Nescafe",
        "Bru", "Brooke Bond", "Red Label", "Coca-Cola", "Coke", "Pepsi", "Lay's", "Lays", "Kurkure",
        "Cadbury", "Surf Excel", "Vim", "Dettol", "Colgate", "Harpic", "Bisleri", "Harvest Gold",
        "Eggoz", "Patanjali", "Dabur", "Nandini", "Epigamia", "Kelloggs", "Quaker", "Lizol",
    ],
    key=len,
    reverse=True,
)
# What shoppers type -> the brand as stores list it.
BRAND_ALIASES = {"Coke": "Coca-Cola", "Lays": "Lay's", "Haldiram": "Haldiram's", "Yippee": "Sunfeast"}
_BRAND_RES = [
    (BRAND_ALIASES.get(b, b), re.compile(rf"(?<!\w){re.escape(b)}(?!\w)", re.IGNORECASE)) for b in KNOWN_BRANDS
]

# Things bought by count: "6 bananas" means six pieces, not six packs.
COUNT_NOUNS = {"egg", "banana", "lemon", "apple", "orange", "coconut", "mango", "kiwi", "lime"}

_BULLET_RE = re.compile(r"^\s*(?:[-*•·]+|\d+[.)]\s)\s*")
_SPLIT_RE = re.compile(r"[,\n;]+|\s+and\s+|\s+&\s+", re.IGNORECASE)
_LEAD_QTY_RE = re.compile(r"^\s*(\d{1,2})\s*(?:[x×]\s*|\s+)(?=\D)")
_TRAIL_QTY_RE = re.compile(r"(?:^|\s)[x×]\s*(\d{1,2})\s*$")
_PACK_QTY_RE = re.compile(r"\b(\d{1,2})\s*(?:packs?|packets?|pkts?|bottles?|cans?|box(?:es)?|bags?|nos?)\b", re.IGNORECASE)
_FILLER_RE = re.compile(r"\b(?:of|some|a|an|the|please|pls|packs?|packets?|pkts?)\b", re.IGNORECASE)


def _singular(word: str) -> str:
    w = word.lower()
    if w.endswith("oes") and len(w) > 4:
        return w[:-2]
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        return w[:-1]
    return w


def _parse_fragment(raw: str, index: int) -> GroceryItem | None:
    text = _BULLET_RE.sub("", raw.strip())
    if not re.search(r"[A-Za-z]", text):
        return None

    size: Size | None = None
    found = find_size(text)
    if found:
        size, (start, end) = found
        text = (text[:start] + " " + text[end:]).strip()

    quantity = 1
    for pattern in (_PACK_QTY_RE, _LEAD_QTY_RE, _TRAIL_QTY_RE):
        m = pattern.search(text)
        if m:
            quantity = max(1, min(50, int(m.group(1))))
            text = (text[: m.start()] + " " + text[m.end() :]).strip()
            break

    brand: str | None = None
    for canonical, pattern in _BRAND_RES:
        m = pattern.search(text)
        if m:
            brand = canonical
            text = (text[: m.start()] + " " + text[m.end() :]).strip()
            break

    name = _FILLER_RE.sub(" ", text)
    name = re.sub(r"[^\w\s%'&-]", " ", name)
    name = re.sub(r"\s+", " ", name).strip(" -").lower()
    if not name:
        if not brand:
            return None
        name = brand.lower()

    words = name.split()
    if size is None and quantity > 1 and words and _singular(words[-1]) in COUNT_NOUNS:
        size, quantity = Size(value=float(quantity), unit="pcs"), 1

    return GroceryItem(
        id=f"item-{index}", raw=raw.strip()[:300], name=name[:120], brand=brand, quantity=quantity, size=size
    )


def parse_with_rules(text: str, settings: Settings | None = None) -> list[GroceryItem]:
    """Deterministic offline parser. Also the fallback when an LLM call fails."""
    items: list[GroceryItem] = []
    for fragment in _SPLIT_RE.split(text):
        if not fragment or not fragment.strip():
            continue
        item = _parse_fragment(fragment, len(items) + 1)
        if item:
            items.append(item)
        if len(items) >= MAX_ITEMS:
            break
    return items


# ---------------------------------------------------------------- LLM provider


class _LLMItem(BaseModel):
    name: str = Field(description="Generic product name in lowercase, without brand, pack size or count. e.g. 'milk'.")
    brand: str | None = Field(description="Brand if the shopper named one, else null.")
    quantity: int = Field(description="How many packs to buy. Default 1.")
    size_value: float | None = Field(description="Pack size number if given (e.g. 1 for '1L'), else null.")
    size_unit: Literal["g", "kg", "ml", "l", "pcs"] | None = Field(description="Pack size unit, else null.")
    notes: str | None = Field(description="Any other preference (e.g. 'full cream', 'brown'), else null.")


class _LLMList(BaseModel):
    items: list[_LLMItem]


_SYSTEM = (
    "You turn a shopper's free-text grocery list into structured items for Indian quick-commerce apps. "
    "Rules: one entry per distinct product. 'quantity' is the number of packs; a number followed by a unit "
    "(1L, 500 g, 2 kg) is a pack size, not a quantity. For things bought by count (eggs, bananas), a bare "
    "number is the pack size in pcs with quantity 1; 'a dozen' is 12 pcs. Keep the shopper's own words for "
    "the name, fix obvious typos, and never invent a brand or a size that was not written."
)


def parse_with_anthropic(text: str, settings: Settings | None = None) -> list[GroceryItem]:
    import anthropic

    settings = settings or get_settings()
    client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=settings.llm_timeout_s, max_retries=1)
    response = client.messages.parse(
        model=settings.parse_model,
        max_tokens=8000,
        system=_SYSTEM,
        messages=[{"role": "user", "content": f"Grocery list:\n{text}"}],
        output_format=_LLMList,
    )
    parsed = response.parsed_output
    if parsed is None:
        raise ValueError(f"no structured output (stop_reason={response.stop_reason})")
    return _from_llm(parsed)


def parse_with_groq(text: str, settings: Settings | None = None) -> list[GroceryItem]:
    """Groq's OpenAI-compatible chat endpoint in JSON mode; the reply is validated with Pydantic."""
    settings = settings or get_settings()
    schema = json.dumps(_LLMList.model_json_schema())
    extra = {"reasoning_effort": settings.groq_reasoning_effort} if settings.groq_reasoning_effort else {}
    resp = httpx.post(
        f"{settings.groq_base_url}/chat/completions",
        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        json={
            **extra,  # parsing a list needs little thought; low effort answers several times faster
            "model": settings.groq_model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": f"{_SYSTEM}\nReply with one JSON object that matches this JSON schema:\n{schema}"},
                {"role": "user", "content": f"Grocery list:\n{text}"},
            ],
        },
        timeout=settings.llm_timeout_s,
    )
    resp.raise_for_status()
    return _from_llm(_LLMList.model_validate_json(resp.json()["choices"][0]["message"]["content"]))


_TO_BASE = {"g": ("g", 1), "kg": ("g", 1000), "ml": ("ml", 1), "l": ("ml", 1000), "pcs": ("pcs", 1)}


def _tidy_brand(brand: str | None) -> str | None:
    brand = (brand or "").strip()[:60]
    if not brand:
        return None
    known = next((canonical for canonical, pattern in _BRAND_RES if pattern.fullmatch(brand)), None)
    return known or (brand.title() if brand.islower() else brand)


def _from_llm(parsed: _LLMList) -> list[GroceryItem]:
    items: list[GroceryItem] = []
    for entry in parsed.items[:MAX_ITEMS]:
        name = re.sub(r"\s+", " ", entry.name).strip().lower()
        if not name:
            continue
        size = None
        if entry.size_value and entry.size_value > 0 and entry.size_unit:
            unit, factor = _TO_BASE[entry.size_unit]
            size = Size(value=round(entry.size_value * factor, 3), unit=unit)
        items.append(
            GroceryItem(
                id=f"item-{len(items) + 1}",
                raw=name,
                name=name[:120],
                brand=_tidy_brand(entry.brand),
                quantity=max(1, min(50, entry.quantity or 1)),
                size=size,
                notes=(entry.notes or "").strip()[:200] or None,
            )
        )
    return items


PROVIDERS: dict[str, Callable[[str, Settings | None], list[GroceryItem]]] = {
    "rules": parse_with_rules,
    "anthropic": parse_with_anthropic,
    "groq": parse_with_groq,
}


def _key_for(provider: str, settings: Settings) -> str | None:
    return {"anthropic": settings.anthropic_api_key, "groq": settings.groq_api_key}.get(provider)


def resolve_provider(settings: Settings) -> str:
    """The provider that will actually run. A provider without its key falls back to rules."""
    wanted = settings.parse_provider
    if wanted == "rules":
        return "rules"
    if wanted in PROVIDERS:
        return wanted if _key_for(wanted, settings) else "rules"
    # auto: Groq first, then Anthropic, then the offline parser
    return next((p for p in ("groq", "anthropic") if _key_for(p, settings)), "rules")


def parse_list(text: str, settings: Settings | None = None) -> tuple[list[GroceryItem], str, list[str]]:
    """Parse a free-text grocery list. Returns (items, provider_used, warnings)."""
    settings = settings or get_settings()
    provider = resolve_provider(settings)
    warnings: list[str] = []
    if provider != "rules":
        try:
            items = PROVIDERS[provider](text, settings)
            if items:
                return items, provider, warnings
            warnings.append(f"{provider} returned no items; used the built-in parser instead.")
        except Exception as exc:  # any provider failure degrades to the offline parser
            log.warning("parse provider %s failed: %s", provider, exc)
            warnings.append(f"{provider} parser was unavailable; used the built-in parser instead.")
    return parse_with_rules(text, settings), "rules", warnings
