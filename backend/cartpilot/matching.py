"""Pick the right product for each grocery item on each app.

Pipeline per (item, app):
  1. shortlist the top-k search results with embeddings
  2. a chooser picks one of them, or "none of these", with a confidence
  3. below the confidence threshold the item is flagged needs_user

Two choosers implement the same interface: ``JevChooser`` (TypeSafe Jev through an
OpenAI-compatible endpoint) and ``FuzzyChooser`` (deterministic, no network). Jev
failures fall back to the fuzzy chooser per call, so a flaky key never breaks a run.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

import httpx
from rapidfuzz import fuzz

from .config import Settings, get_settings
from .embeddings import Embedder, cosine, get_embedder
from .models import AppMatch, GroceryItem, ItemMatch, MatchRequest, MatchResponse, Product, Variant
from .units import UNIT_WORDS, format_size, same_size, size_similarity

log = logging.getLogger("cartpilot.match")

NONE_BELOW = 0.5  # best fuzzy score under this means "none of these"
MAX_VARIANTS = 6
FAST_PATH = 0.9  # a fuzzy match this sure is accepted without asking the model
MAX_SUBSTITUTE_CHECKS = 8

_STOP = {
    "of", "the", "a", "an", "and", "with", "fresh", "pack", "packet", "pouch", "bottle", "jar", "box",
    "tin", "combo", "new", "x",
} | set(UNIT_WORDS)


# ---------------------------------------------------------------- text helpers


def _singular(word: str) -> str:
    if word.endswith("oes") and len(word) > 4:
        return word[:-2]
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    if word.endswith("s") and not word.endswith("ss") and len(word) > 3:
        return word[:-1]
    return word


def tokens(text: str | None) -> list[str]:
    """Lowercase content words: no sizes, numbers, units or filler."""
    if not text:
        return []
    out: list[str] = []
    for raw in re.sub(r"[^a-z0-9]+", " ", text.lower().replace("'", "")).split():
        if raw.isdigit() or len(raw) < 2 or raw in _STOP or re.fullmatch(r"\d+[a-z]{1,3}", raw):
            continue
        word = _singular(raw)
        if word not in out:
            out.append(word)
    return out


def _has(token: str, pool: list[str]) -> bool:
    return token in pool or any(fuzz.ratio(token, p) >= 88 for p in pool)


def _query_tokens(item: GroceryItem) -> tuple[list[str], list[str]]:
    brand = tokens(item.brand)
    name = [t for t in tokens(item.name) if t not in brand]
    notes = [t for t in tokens(item.notes) if t not in brand and t not in name]
    return (name + notes) or brand, brand


def fuzzy_score(item: GroceryItem, product: Product) -> float:
    """0..1 similarity between what the shopper wrote and a product listing."""
    query, brand = _query_tokens(item)
    prod_brand = tokens(product.brand)
    prod = tokens(product.name)
    pool = prod + [t for t in prod_brand if t not in prod]
    if not query or not pool:
        return 0.0

    matched = [t for t in query if _has(t, pool)]
    cover = len(matched) / len(query)
    token_set = fuzz.token_set_ratio(" ".join(query), " ".join(pool)) / 100
    extra = [t for t in prod if t not in prod_brand and t not in brand and not _has(t, query)]
    score = 0.7 * cover + 0.3 * token_set - min(0.10, 0.02 * len(extra))

    if brand and not all(_has(t, pool) for t in brand):
        score *= 0.5
    if item.size is not None:
        sim = size_similarity(item.size, product.size)
        if sim is None:
            score *= 0.85
        elif sim < 0.97:
            score *= 0.45 + 0.35 * sim
    if product.rank is not None:
        score += max(0.0, 0.03 - 0.01 * product.rank)
    return max(0.0, min(1.0, score))


# ---------------------------------------------------------------- choosers


@dataclass(frozen=True)
class Choice:
    index: int | None  # index into the options, or None for "none of these"
    confidence: float
    reason: str = ""


class Chooser(Protocol):
    name: str

    def choose(self, item: GroceryItem, options: list[Product]) -> Choice: ...

    def acceptable_substitute(self, item: GroceryItem, wanted: Product | None, candidate: Product) -> bool: ...

    def choose_many(self, item: GroceryItem, options_by_app: dict[str, list[Product]]) -> dict[str, Choice]: ...

    def filter_substitutes(self, item: GroceryItem, wanted: Product | None, candidates: list[Product]) -> list[bool]: ...


class _OneByOne:
    """Default batch behaviour: just loop. Model-backed choosers override these with one call."""

    def choose_many(self, item: GroceryItem, options_by_app: dict[str, list[Product]]) -> dict[str, Choice]:
        return {app: self.choose(item, options) for app, options in options_by_app.items()}  # type: ignore[attr-defined]

    def filter_substitutes(self, item: GroceryItem, wanted: Product | None, candidates: list[Product]) -> list[bool]:
        return [self.acceptable_substitute(item, wanted, c) for c in candidates]  # type: ignore[attr-defined]


class FuzzyChooser(_OneByOne):
    """Deterministic fallback. Confident only when one option clearly wins."""

    name = "fuzzy"

    def choose(self, item: GroceryItem, options: list[Product]) -> Choice:
        if not options:
            return Choice(None, 1.0, "no search results")
        scored = sorted(((fuzzy_score(item, p), i) for i, p in enumerate(options)), reverse=True)
        top, index = scored[0]
        runner_up = scored[1][0] if len(scored) > 1 else 0.0
        if top < NONE_BELOW:
            return Choice(None, round(1 - top, 3), "no result is close enough")
        margin = top - runner_up
        confidence = top * min(1.0, 0.55 + 3 * margin)
        reason = "clear best match" if margin >= 0.15 else "several similar products"
        return Choice(index, round(confidence, 3), reason)

    def acceptable_substitute(self, item: GroceryItem, wanted: Product | None, candidate: Product) -> bool:
        query, _ = _query_tokens(item)
        pool = tokens(candidate.name) + tokens(candidate.brand)
        if not query or not all(_has(t, pool) for t in query):
            return False
        target = item.size or (wanted.size if wanted else None)
        sim = size_similarity(target, candidate.size)
        if sim is not None and sim < 0.75:
            return False
        if wanted is not None:
            core_w = [t for t in tokens(wanted.name) if t not in tokens(wanted.brand)]
            core_c = [t for t in tokens(candidate.name) if t not in tokens(candidate.brand)]
            if core_w and core_c and fuzz.token_set_ratio(" ".join(core_w), " ".join(core_c)) < 60:
                return False
        return True


def _describe(p: Product) -> str:
    size = p.size_text or format_size(p.size)
    return " | ".join(x for x in (p.name, f"brand {p.brand}" if p.brand else "", size, f"Rs {p.price:g}") if x)


def _describe_item(item: GroceryItem) -> str:
    parts = [f"name: {item.name}"]
    if item.brand:
        parts.append(f"brand: {item.brand}")
    if item.size:
        parts.append(f"pack size: {format_size(item.size)}")
    if item.notes:
        parts.append(f"notes: {item.notes}")
    return "; ".join(parts)


class JevChooser(_OneByOne):
    """A chat model behind an OpenAI-compatible endpoint (TypeSafe Jev, or Groq).

    ``choose`` is the Choice primitive: pick exactly one of a closed set of labels,
    where label 0 is always "none of these". ``acceptable_substitute`` is the yes/no
    (Noul) check. ``choose_many`` and ``filter_substitutes`` do the same work for a
    whole item in one request. Any transport or format error falls back to the
    fuzzy chooser, and identical questions are answered from a small cache.
    """

    name = "jev"
    _CACHE_SIZE = 512
    _RETRY_STATUS = {429, 500, 502, 503, 504}

    def __init__(self, settings: Settings, client: httpx.Client | None = None, max_retries: int = 2) -> None:
        self._settings = settings
        self.name = settings.matcher_name if settings.matcher_name != "fuzzy" else "jev"
        self._fallback = FuzzyChooser()
        self._max_retries = max_retries
        self._cache: dict[tuple[str, str], dict] = {}
        self._lock = threading.Lock()
        self.calls = 0  # requests actually sent, for logs and tests
        self._client = client or httpx.Client(
            base_url=settings.jev_base_url,
            headers={"Authorization": f"Bearer {settings.jev_api_key}", "X-Title": "CartPilot"},
            timeout=settings.llm_timeout_s,
        )

    def _ask(self, system: str, user: str) -> dict:
        key = (system, user)
        with self._lock:
            if key in self._cache:
                return self._cache[key]
        body = {
            **({"reasoning_effort": self._settings.groq_reasoning_effort} if self.name == "groq" and self._settings.groq_reasoning_effort else {}),
            "model": self._settings.jev_model,
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        for attempt in range(self._max_retries + 1):
            with self._lock:
                self.calls += 1
            resp = self._client.post("/chat/completions", json=body)
            if resp.status_code in self._RETRY_STATUS and attempt < self._max_retries:
                try:
                    wait = float(resp.headers.get("retry-after", ""))
                except ValueError:
                    wait = 0.6 * (attempt + 1)
                time.sleep(max(0.0, min(wait, 4.0)))  # rate limits are short; never stall a request for long
                continue
            resp.raise_for_status()
            break
        content = resp.json()["choices"][0]["message"]["content"]
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise ValueError("no JSON object in model reply")
        data = json.loads(match.group(0))
        with self._lock:
            if len(self._cache) >= self._CACHE_SIZE:
                self._cache.pop(next(iter(self._cache)))
            self._cache[key] = data
        return data

    @staticmethod
    def _read_choice(data: dict, n_options: int) -> Choice:
        number = int(data["choice"])
        confidence = max(0.0, min(1.0, float(data["confidence"])))
        if not 0 <= number <= n_options:
            raise ValueError(f"choice {number} out of range")
        return Choice(None if number == 0 else number - 1, confidence, str(data.get("reason", ""))[:200])

    def choose(self, item: GroceryItem, options: list[Product]) -> Choice:
        if not options:
            return Choice(None, 1.0, "no search results")
        lines = ["0. NONE OF THESE"] + [f"{i + 1}. {_describe(p)}" for i, p in enumerate(options)]
        system = (
            "You match a shopper's grocery item to store listings. Choose exactly one numbered option. "
            "Choose 0 (NONE OF THESE) unless an option is the product the shopper asked for. A different "
            "pack size, flavour or variant than the one requested is not a match. If the request does not "
            'say which variant and several options fit, pick the most standard one but lower "confidence". '
            'Reply with JSON only: {"choice": <number>, "confidence": <0..1>, "reason": "<short>"}.'
        )
        user = f"Shopper wants -> {_describe_item(item)}\nOptions:\n" + "\n".join(lines)
        try:
            return self._read_choice(self._ask(system, user), len(options))
        except Exception as exc:
            log.warning("%s choose failed, using fuzzy: %s", self.name, exc)
            return self._fallback.choose(item, options)

    def choose_many(self, item: GroceryItem, options_by_app: dict[str, list[Product]]) -> dict[str, Choice]:
        """One request for every store that still needs a decision on this item."""
        out = {app: Choice(None, 1.0, "no search results") for app, options in options_by_app.items() if not options}
        todo = {app: options for app, options in options_by_app.items() if options}
        if len(todo) <= 1:
            out.update({app: self.choose(item, options) for app, options in todo.items()})
            return out
        blocks = []
        for app, options in todo.items():
            lines = ["0. NONE OF THESE"] + [f"{i + 1}. {_describe(p)}" for i, p in enumerate(options)]
            blocks.append(f"Store {app}:\n" + "\n".join(lines))
        system = (
            "You match one grocery item to listings on several stores. For EACH store choose exactly one "
            "numbered option. Choose 0 (NONE OF THESE) unless an option is the product the shopper asked for. "
            "A different pack size, flavour or variant than the one requested is not a match. Pick the same "
            "real-world product on every store where it is listed. If the request does not say which variant "
            'and several options fit, pick the most standard one but lower "confidence". Reply with JSON only, '
            'one key per store: {"<store>": {"choice": <number>, "confidence": <0..1>, "reason": "<short>"}}.'
        )
        user = f"Shopper wants -> {_describe_item(item)}\n\n" + "\n\n".join(blocks)
        try:
            data = self._ask(system, user)
        except Exception as exc:
            log.warning("%s choose_many failed, using fuzzy: %s", self.name, exc)
            data = {}
        for app, options in todo.items():
            try:
                out[app] = self._read_choice(data[app], len(options))
            except Exception:
                out[app] = self._fallback.choose(item, options)  # a store the model skipped or garbled
        return out

    def filter_substitutes(self, item: GroceryItem, wanted: Product | None, candidates: list[Product]) -> list[bool]:
        """One yes/no request covering every proposed substitute."""
        if not candidates:
            return []
        if len(candidates) == 1:
            return [self.acceptable_substitute(item, wanted, candidates[0])]
        system = (
            "The shopper's first choice is out of stock. Decide which proposed products are acceptable "
            "substitutes: the same kind of product, a similar pack size, and nothing the shopper explicitly "
            'ruled out. Reply with JSON only: {"acceptable": [<numbers of acceptable options>]}.'
        )
        user = (
            f"Shopper wants -> {_describe_item(item)}\nOut of stock -> {_describe(wanted) if wanted else 'unknown'}\n"
            "Proposed substitutes:\n" + "\n".join(f"{i + 1}. {_describe(c)}" for i, c in enumerate(candidates))
        )
        try:
            accepted = {int(n) for n in self._ask(system, user)["acceptable"]}
            return [(i + 1) in accepted for i in range(len(candidates))]
        except Exception as exc:
            log.warning("%s substitute filter failed, using fuzzy: %s", self.name, exc)
            return [self._fallback.acceptable_substitute(item, wanted, c) for c in candidates]

    def acceptable_substitute(self, item: GroceryItem, wanted: Product | None, candidate: Product) -> bool:
        system = (
            "Answer whether a product is an acceptable substitute when the shopper's first choice is out of "
            "stock. Acceptable means the same kind of product, a similar pack size, and nothing the shopper "
            'explicitly ruled out. Reply with JSON only: {"answer": true|false}.'
        )
        user = (
            f"Shopper wants -> {_describe_item(item)}\n"
            f"Out of stock -> {_describe(wanted) if wanted else 'unknown'}\n"
            f"Proposed substitute -> {_describe(candidate)}"
        )
        try:
            return bool(self._ask(system, user)["answer"])
        except Exception as exc:
            log.warning("%s substitute check failed, using fuzzy: %s", self.name, exc)
            return self._fallback.acceptable_substitute(item, wanted, candidate)


def get_chooser(settings: Settings) -> Chooser:
    return JevChooser(settings) if settings.jev_enabled else FuzzyChooser()


# ---------------------------------------------------------------- shortlist + variants


def shortlist(item: GroceryItem, products: list[Product], embedder: Embedder, k: int) -> list[Product]:
    """Top-k products by embedding similarity to the item, ties broken by store rank."""
    if len(products) <= k:
        return list(products)
    texts = [item.search_query] + [f"{p.brand or ''} {p.name} {p.size_text or ''}" for p in products]
    vectors = embedder.embed(texts)
    query, rest = vectors[0], vectors[1:]
    order = sorted(
        range(len(products)),
        key=lambda i: (-cosine(query, rest[i]), products[i].rank if products[i].rank is not None else i),
    )
    return [products[i] for i in order[:k]]


def _core(p: Product) -> set[str]:
    return set(tokens(p.name)) | set(tokens(p.brand))


def _same_product(a: Product, b: Product) -> bool:
    if not same_size(a.size, b.size):
        return False
    if a.brand and b.brand and tokens(a.brand) != tokens(b.brand):
        return False
    ta, tb = _core(a), _core(b)
    if not ta or not tb:
        return False
    jaccard = len(ta & tb) / len(ta | tb)
    return jaccard >= 0.5 or fuzz.token_sort_ratio(" ".join(sorted(ta)), " ".join(sorted(tb))) >= 88


def build_variants(
    scored: list[tuple[float, Product]], kind: str = "option", item: GroceryItem | None = None
) -> list[Variant]:
    """Group listings of the same real-world product across apps."""
    clusters: list[dict] = []
    for score, product in sorted(scored, key=lambda sp: (-sp[0], sp[1].rank or 0, sp[1].app)):
        for cluster in clusters:
            if product.app not in cluster["per_app"] and _same_product(cluster["rep"], product):
                cluster["per_app"][product.app] = product
                break
        else:
            clusters.append({"rep": product, "score": score, "per_app": {product.app: product}})

    def stock(c: dict) -> int:
        return sum(1 for p in c["per_app"].values() if p.in_stock)

    clusters.sort(key=lambda c: (-round(c["score"], 2), -stock(c), c["rep"].rank or 0))
    brand = tokens(item.brand) if item else []
    variants: list[Variant] = []
    for cluster in clusters[:MAX_VARIANTS]:
        rep: Product = cluster["rep"]
        label = min((p.name for p in cluster["per_app"].values()), key=len)
        size_text = rep.size_text or format_size(rep.size)
        key = re.sub(r"[^a-z0-9]+", "-", f"{label} {size_text}".lower()).strip("-")
        variants.append(
            Variant(
                key=key,
                label=label,
                size_text=size_text,
                kind=kind,  # type: ignore[arg-type]
                score=round(cluster["score"], 3),
                different_brand=bool(brand) and not all(_has(t, list(_core(rep))) for t in brand),
                per_app=cluster["per_app"],
            )
        )
    return variants


# ---------------------------------------------------------------- orchestration


_FUZZY = FuzzyChooser()


def _decide(item: GroceryItem, shortlists: dict[str, list[Product]], chooser: Chooser) -> dict[str, Choice]:
    """One Choice per app. The model is only asked about stores the fuzzy matcher is not sure of."""
    if chooser.name == "fuzzy":
        return {app: chooser.choose(item, options) for app, options in shortlists.items()}
    decided: dict[str, Choice] = {}
    unsure: dict[str, list[Product]] = {}
    for app, options in shortlists.items():
        quick = _FUZZY.choose(item, options)
        if not options or (quick.index is not None and quick.confidence >= FAST_PATH):
            decided[app] = quick
        else:
            unsure[app] = options
    if unsure:
        decided.update(chooser.choose_many(item, unsure))
    return decided


def _to_app_match(choice: Choice, options: list[Product], threshold: float) -> AppMatch:
    if choice.index is None:
        return AppMatch(status="not_found", confidence=choice.confidence, reason=choice.reason)
    product = options[choice.index]
    if choice.confidence < threshold:
        return AppMatch(status="needs_user", product=product, confidence=choice.confidence, reason=choice.reason)
    status = "matched" if product.in_stock else "out_of_stock"
    return AppMatch(status=status, product=product, confidence=choice.confidence, reason=choice.reason)


def _match_item(
    item: GroceryItem,
    per_app_candidates: dict[str, list[Product]],
    chooser: Chooser,
    embedder: Embedder,
    settings: Settings,
) -> ItemMatch:
    shortlists = {
        app: shortlist(item, products, embedder, settings.shortlist_size)
        for app, products in per_app_candidates.items()
    }
    choices = _decide(item, shortlists, chooser)
    per_app = {app: _to_app_match(choices[app], shortlists[app], settings.confidence_threshold) for app in shortlists}

    scored = [(fuzzy_score(item, p), p) for options in shortlists.values() for p in options]
    chosen = {id(m.product) for m in per_app.values() if m.product is not None}
    top = max((s for s, _ in scored), default=0.0)
    cutoff = max(NONE_BELOW, top - 0.3)
    # Whatever the chooser picked is always offered to the user, even with a low fuzzy score.
    variants = build_variants([(s, p) for s, p in scored if s >= cutoff or id(p) in chosen], item=item)

    statuses = {m.status for m in per_app.values()}
    substitutes: list[Variant] = []
    if "needs_user" in statuses:
        status = "needs_user"
    elif "matched" in statuses:
        status = "matched"
    elif "out_of_stock" in statuses:
        status = "out_of_stock"
        # Cheap rule first, then one model request for whatever survives it.
        wanted = next((m.product for m in per_app.values() if m.product is not None), None)
        pool = [
            c
            for app, products in per_app_candidates.items()
            for c in products
            if c.in_stock and c is not per_app[app].product and _FUZZY.acceptable_substitute(item, per_app[app].product, c)
        ]
        pool.sort(key=lambda c: -_substitute_score(item, wanted, c))
        pool = pool[: MAX_SUBSTITUTE_CHECKS * max(1, len(per_app_candidates))]
        verdicts = [True] * len(pool) if chooser.name == "fuzzy" else chooser.filter_substitutes(item, wanted, pool)
        subs = [(_substitute_score(item, wanted, c), c) for c, ok in zip(pool, verdicts, strict=False) if ok]
        substitutes = build_variants(subs, kind="substitute", item=item)
    else:
        status = "not_found"

    decided = [m.confidence for m in per_app.values() if m.status != "not_found"]
    return ItemMatch(
        item_id=item.id,
        status=status,  # type: ignore[arg-type]
        needs_user=status == "needs_user" or bool(substitutes),
        confidence=round(min(decided), 3) if decided else 0.0,
        per_app=per_app,
        variants=variants,
        substitutes=substitutes,
    )


def _substitute_score(item: GroceryItem, wanted: Product | None, candidate: Product) -> float:
    """Rank substitutes by pack-size closeness, ignoring the brand the shopper could not get."""
    generic = item.model_copy(update={"brand": None})
    score = fuzzy_score(generic, candidate)
    sim = size_similarity(item.size or (wanted.size if wanted else None), candidate.size)
    return score * (0.6 + 0.4 * sim) if sim is not None else score


def match_items(
    request: MatchRequest,
    settings: Settings | None = None,
    chooser: Chooser | None = None,
    embedder: Embedder | None = None,
) -> MatchResponse:
    settings = settings or get_settings()
    chooser = chooser or get_chooser(settings)
    embedder = embedder or get_embedder(settings)

    def work(item: GroceryItem) -> ItemMatch:
        per_app = {app: by_item.get(item.id, []) for app, by_item in request.candidates.items()}
        return _match_item(item, per_app, chooser, embedder, settings)

    if chooser.name != "fuzzy" and len(request.items) > 1:
        with ThreadPoolExecutor(max_workers=4) as pool:
            matches = list(pool.map(work, request.items))
    else:
        matches = [work(item) for item in request.items]

    return MatchResponse(
        matches=matches,
        matcher=chooser.name,  # type: ignore[arg-type]
        embedder=embedder.name,
        threshold=settings.confidence_threshold,
    )
