"""Typed request/response models shared by every endpoint."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

MAX_ITEMS = 60
MAX_CANDIDATES_PER_ITEM = 40

BaseUnit = Literal["g", "ml", "pcs"]


class Size(BaseModel):
    """A pack size in base units (g, ml or pcs)."""

    value: float = Field(gt=0)
    unit: BaseUnit


# ---------------------------------------------------------------- /parse


class GroceryItem(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    raw: str = Field(default="", max_length=300)
    name: str = Field(min_length=1, max_length=120)
    brand: str | None = Field(default=None, max_length=60)
    quantity: int = Field(default=1, ge=1, le=50)
    size: Size | None = None
    notes: str | None = Field(default=None, max_length=200)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def search_query(self) -> str:
        """What the extension types into a store's search box."""
        from .units import format_size

        parts: list[str] = []
        if self.brand and self.brand.lower() not in self.name.lower():
            parts.append(self.brand)
        parts.append(self.name)
        if self.size:
            parts.append(format_size(self.size))
        return " ".join(parts).strip()


class ParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ParseResponse(BaseModel):
    items: list[GroceryItem]
    provider: str
    warnings: list[str] = []


# ---------------------------------------------------------------- /match


class Product(BaseModel):
    """One product as normalised by an extension adapter."""

    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1, max_length=200)
    app: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=300)
    brand: str | None = Field(default=None, max_length=120)
    size_text: str | None = Field(default=None, max_length=80)
    size: Size | None = None
    price: float = Field(ge=0, le=1_000_000)
    mrp: float | None = Field(default=None, ge=0, le=1_000_000)
    in_stock: bool = True
    image: str | None = Field(default=None, max_length=2000)
    rank: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _derive_size(self) -> "Product":
        if self.size is None:
            from .units import parse_size

            self.size = parse_size(self.size_text) or parse_size(self.name)
        return self


class MatchRequest(BaseModel):
    items: list[GroceryItem] = Field(min_length=1, max_length=MAX_ITEMS)
    # candidates[app][item_id] -> products that app's search returned for the item
    candidates: dict[str, dict[str, list[Product]]]

    @model_validator(mode="after")
    def _limits(self) -> "MatchRequest":
        if len(self.candidates) > 8:
            raise ValueError("too many apps")
        for per_item in self.candidates.values():
            for products in per_item.values():
                if len(products) > MAX_CANDIDATES_PER_ITEM:
                    del products[MAX_CANDIDATES_PER_ITEM:]
        return self


AppMatchStatus = Literal["matched", "needs_user", "out_of_stock", "not_found"]


class AppMatch(BaseModel):
    status: AppMatchStatus
    product: Product | None = None
    confidence: float = 0.0
    reason: str = ""


class Variant(BaseModel):
    """The same real-world product as listed on one or more apps."""

    key: str
    label: str
    size_text: str = ""
    kind: Literal["option", "substitute"] = "option"
    score: float = 0.0
    different_brand: bool = False
    per_app: dict[str, Product]


class ItemMatch(BaseModel):
    item_id: str
    status: AppMatchStatus
    needs_user: bool
    confidence: float
    per_app: dict[str, AppMatch]
    # Always includes an implicit "none of these": the client may skip any item.
    variants: list[Variant] = []
    substitutes: list[Variant] = []


class MatchResponse(BaseModel):
    matches: list[ItemMatch]
    matcher: Literal["jev", "groq", "fuzzy"]
    embedder: str
    threshold: float
    warnings: list[str] = []


# ---------------------------------------------------------------- /optimize


class FeeConfig(BaseModel):
    delivery_fee: float = Field(default=0, ge=0, le=10_000)
    # Subtotal at or above which delivery is free. None = delivery is never free.
    free_delivery_threshold: float | None = Field(default=None, ge=0, le=1_000_000)
    handling_fee: float = Field(default=0, ge=0, le=10_000)
    small_cart_fee: float = Field(default=0, ge=0, le=10_000)
    small_cart_threshold: float = Field(default=0, ge=0, le=1_000_000)


class Offer(BaseModel):
    product_id: str
    name: str
    unit_price: float = Field(ge=0, le=1_000_000)
    size_text: str | None = None


class OptimizeItem(BaseModel):
    item_id: str
    name: str
    quantity: int = Field(default=1, ge=1, le=50)
    offers: dict[str, Offer] = {}


class OptimizeRequest(BaseModel):
    items: list[OptimizeItem] = Field(min_length=1, max_length=MAX_ITEMS)
    fees: dict[str, FeeConfig]
    max_apps: int | None = Field(default=None, ge=1, le=8)
    # Only recommend a split if it beats the best single app by at least this much.
    min_split_saving: float = Field(default=0, ge=0, le=100_000)

    @model_validator(mode="after")
    def _known_apps(self) -> "OptimizeRequest":
        if len(self.fees) > 8:
            raise ValueError("too many apps")
        for item in self.items:
            unknown = set(item.offers) - set(self.fees)
            if unknown:
                raise ValueError(f"item {item.item_id!r} has offers for apps without fees: {sorted(unknown)}")
        ids = [i.item_id for i in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("item_id values must be unique")
        return self


class CartLine(BaseModel):
    item_id: str
    name: str
    product_id: str
    product_name: str
    size_text: str | None = None
    quantity: int
    unit_price: float
    line_total: float


class AppCart(BaseModel):
    app: str
    lines: list[CartLine]
    subtotal: float
    delivery_fee: float
    handling_fee: float
    small_cart_fee: float
    total: float
    # How much more the subtotal needs to reach free delivery (None if already free / never free).
    free_delivery_gap: float | None = None


class Baseline(BaseModel):
    app: str
    total: float
    complete: bool
    missing: list[str] = []


class OptimizeResponse(BaseModel):
    assignment: dict[str, str]
    carts: list[AppCart]
    total: float
    unfulfilled: list[str]
    baselines: list[Baseline]
    best_single: Baseline | None
    savings: float | None
    savings_pct: float | None
    method: Literal["exhaustive", "ilp", "none"]
    # True when a cheaper split existed but did not clear min_split_saving.
    kept_single_app: bool = False
    split_total: float | None = None
    notes: list[str] = []
