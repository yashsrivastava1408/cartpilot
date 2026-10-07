"""Pack-size parsing. Every size is reduced to one of three base units: g, ml, pcs."""

from __future__ import annotations

import re

from .models import Size

_UNITS: dict[str, tuple[str, float]] = {
    "kg": ("g", 1000), "kgs": ("g", 1000), "kilo": ("g", 1000), "kilos": ("g", 1000),
    "g": ("g", 1), "gm": ("g", 1), "gms": ("g", 1), "gram": ("g", 1), "grams": ("g", 1),
    "l": ("ml", 1000), "lt": ("ml", 1000), "ltr": ("ml", 1000), "ltrs": ("ml", 1000),
    "litre": ("ml", 1000), "litres": ("ml", 1000), "liter": ("ml", 1000), "liters": ("ml", 1000),
    "ml": ("ml", 1),
    "pc": ("pcs", 1), "pcs": ("pcs", 1), "piece": ("pcs", 1), "pieces": ("pcs", 1),
    "unit": ("pcs", 1), "units": ("pcs", 1),
    "dozen": ("pcs", 12),
}
UNIT_WORDS = frozenset(_UNITS)

_UNIT_ALT = "|".join(sorted(_UNITS, key=len, reverse=True))
SIZE_RE = re.compile(
    rf"(?<![\w.])(\d+(?:\.\d+)?)\s*(?:[x×]\s*(\d+(?:\.\d+)?)\s*)?({_UNIT_ALT})\b",
    re.IGNORECASE,
)
_BARE_DOZEN_RE = re.compile(r"\b(half\s+)?(?:a\s+)?dozen\b", re.IGNORECASE)
_PACK_OF_RE = re.compile(r"\bpack\s+of\s+(\d{1,3})\b", re.IGNORECASE)


def find_size(text: str) -> tuple[Size, tuple[int, int]] | None:
    """Return the first size found in ``text`` and the span it occupies."""
    m = SIZE_RE.search(text)
    if m:
        value = float(m.group(1))
        if m.group(2):
            value *= float(m.group(2))
        unit, factor = _UNITS[m.group(3).lower()]
        if value > 0:
            return Size(value=round(value * factor, 3), unit=unit), m.span()
    m = _BARE_DOZEN_RE.search(text)
    if m:
        return Size(value=6 if m.group(1) else 12, unit="pcs"), m.span()
    m = _PACK_OF_RE.search(text)
    if m:
        return Size(value=float(m.group(1)), unit="pcs"), m.span()
    return None


def parse_size(text: str | None) -> Size | None:
    if not text:
        return None
    found = find_size(text)
    return found[0] if found else None


def format_size(size: Size | None) -> str:
    if size is None:
        return ""
    v = size.value
    if size.unit == "g" and v >= 1000:
        return f"{_num(v / 1000)} kg"
    if size.unit == "ml" and v >= 1000:
        return f"{_num(v / 1000)} L"
    return f"{_num(v)} {size.unit}"


def _num(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def size_similarity(a: Size | None, b: Size | None) -> float | None:
    """1.0 for the same pack size, lower as they drift apart, None if unknown."""
    if a is None or b is None:
        return None
    if a.unit != b.unit:
        return 0.0
    lo, hi = sorted((a.value, b.value))
    return lo / hi if hi else 0.0


def same_size(a: Size | None, b: Size | None, tolerance: float = 0.03) -> bool:
    if a is None and b is None:
        return True
    sim = size_similarity(a, b)
    return sim is not None and sim >= 1 - tolerance
