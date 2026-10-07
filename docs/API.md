# API reference

The backend is a FastAPI app on `http://localhost:8000`. Interactive docs are at
`/docs` while it runs. All bodies are JSON. Prices are in rupees.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Is it up, and which providers are active |
| POST | `/parse` | Free text → typed grocery items |
| POST | `/match` | Items + per-app search results → chosen products |
| POST | `/optimize` | Offers + fees → cheapest split |
| POST | `/mock/collect` | What the mock stores return for a list of items (no browser) |
| GET | `/mock/{store}/` | A mock storefront page (`zepto`, `blinkit`, `instamart`) |
| * | `/mock/{store}/api/...` | The mock stores' own search, cart and config APIs |
| GET | `/app/` | The web UI |

## Errors

Every error has the same shape. `request_id` also comes back in the `X-Request-ID` header.

```json
{
  "error": {
    "code": "invalid_request",
    "message": "text: String should have at least 1 character",
    "request_id": "29a0dab6e359",
    "details": [{ "field": "text", "message": "String should have at least 1 character" }]
  }
}
```

| Status | `code` | When |
|---|---|---|
| 422 | `invalid_request` | The body failed validation |
| 4xx | `http_error` | Other client errors, such as text with no grocery items in it |
| 500 | `internal_error` | A bug. The message is generic; details are in the server log |

## GET /healthz

```json
{
  "status": "ok",
  "version": "1.0.0",
  "parse_provider": "rules",
  "matcher": "fuzzy",
  "embedder": "local-hash",
  "ilp_available": true,
  "confidence_threshold": 0.8
}
```

`parse_provider` is `rules`, `groq` or `anthropic`. `matcher` is `fuzzy`, `groq` or `jev`.
These show what will actually run given the keys that are set.

## POST /parse

Request (`text` is 1 to 4000 characters):

```json
{ "text": "2 maggi, onion 1kg" }
```

Response:

```json
{
  "items": [
    { "id": "item-1", "raw": "2 maggi", "name": "maggi", "brand": "Maggi", "quantity": 2,
      "size": null, "notes": null, "search_query": "maggi" },
    { "id": "item-2", "raw": "onion 1kg", "name": "onion", "brand": null, "quantity": 1,
      "size": { "value": 1000.0, "unit": "g" }, "notes": null, "search_query": "onion 1 kg" }
  ],
  "provider": "rules",
  "warnings": []
}
```

- `quantity` is the number of packs. `size` is the pack size in base units: `g`, `ml` or `pcs`.
- `search_query` is what the extension types into a store's search box.
- At most 60 items are returned.
- If an LLM provider fails, the rule parser is used and `warnings` says so.

## POST /match

Request:

```json
{
  "items": [ /* items exactly as /parse returned them */ ],
  "candidates": {
    "zepto":   { "item-1": [ /* products */ ], "item-2": [ /* products */ ] },
    "blinkit": { "item-1": [ /* products */ ] }
  }
}
```

`candidates[app][item_id]` is the list of products that app's search returned for
that item, in the store's own order. A product:

```json
{
  "id": "z-onion-1kg", "app": "zepto", "name": "Onion", "brand": null,
  "size_text": "1 kg", "price": 42.0, "mrp": 45.0, "in_stock": true,
  "image": "🧅", "rank": 0
}
```

`size` is derived from `size_text` (or the name) if you do not send it. Up to 40
products per item are considered.

Response (one item shown, trimmed to one app):

```json
{
  "matcher": "fuzzy",
  "embedder": "local-hash",
  "threshold": 0.8,
  "warnings": [],
  "matches": [
    {
      "item_id": "item-2",
      "status": "matched",
      "needs_user": false,
      "confidence": 1.0,
      "per_app": {
        "zepto": { "status": "matched", "product": { "id": "z-onion-1kg", "...": "..." },
                   "confidence": 1.0, "reason": "clear best match" }
      },
      "variants": [
        { "key": "onion-1-kg", "label": "Onion", "size_text": "1 kg", "kind": "option",
          "score": 1.0, "different_brand": false,
          "per_app": { "zepto": { "id": "z-onion-1kg", "...": "..." } } }
      ],
      "substitutes": []
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `status` | `matched`, `needs_user`, `out_of_stock` or `not_found` (item level and per app) |
| `needs_user` | `true` when the UI must ask: an unsure match, or an out-of-stock item with a substitute to offer |
| `confidence` | The lowest confidence among the apps that found something |
| `variants` | The same real-world product grouped across apps. Picking one variant answers the question for every app at once |
| `substitutes` | Offered only when the item is out of stock on every app. Never applied automatically |

"None of these" is always a valid answer: the client may leave any item out.

## POST /optimize

Request:

```json
{
  "items": [
    {
      "item_id": "item-1", "name": "onion", "quantity": 1,
      "offers": {
        "zepto":   { "product_id": "z-onion-1kg", "name": "Onion", "unit_price": 42, "size_text": "1 kg" },
        "blinkit": { "product_id": "b-onion-1kg", "name": "Onion (Pyaz)", "unit_price": 38, "size_text": "1 kg" }
      }
    }
  ],
  "fees": {
    "zepto":   { "delivery_fee": 30, "free_delivery_threshold": 249, "handling_fee": 5,
                 "small_cart_fee": 20, "small_cart_threshold": 99 },
    "blinkit": { "delivery_fee": 25, "free_delivery_threshold": 199, "handling_fee": 4,
                 "small_cart_fee": 15, "small_cart_threshold": 99 }
  },
  "max_apps": null,
  "min_split_saving": 0
}
```

- An item with empty `offers` is reported back in `unfulfilled`.
- Every app named in an offer must have an entry in `fees`.
- `free_delivery_threshold: null` means delivery is never free.
- `max_apps` caps how many apps the plan may use.
- `min_split_saving` keeps everything on one app unless splitting saves at least this much.

Response:

```json
{
  "assignment": { "item-1": "blinkit" },
  "carts": [
    {
      "app": "blinkit",
      "lines": [
        { "item_id": "item-1", "name": "onion", "product_id": "b-onion-1kg",
          "product_name": "Onion (Pyaz)", "size_text": "1 kg",
          "quantity": 1, "unit_price": 38.0, "line_total": 38.0 }
      ],
      "subtotal": 38.0, "delivery_fee": 25.0, "handling_fee": 4.0, "small_cart_fee": 15.0,
      "total": 82.0, "free_delivery_gap": 161.0
    }
  ],
  "total": 82.0,
  "unfulfilled": [],
  "baselines": [
    { "app": "blinkit", "total": 82.0, "complete": true, "missing": [] },
    { "app": "zepto",   "total": 97.0, "complete": true, "missing": [] }
  ],
  "best_single": { "app": "blinkit", "total": 82.0, "complete": true, "missing": [] },
  "savings": 0.0,
  "savings_pct": 0.0,
  "method": "exhaustive",
  "kept_single_app": false,
  "split_total": 82.0,
  "notes": []
}
```

| Field | Meaning |
|---|---|
| `baselines` | What each single app would cost for everything it carries. `complete` is false if it lacks some items |
| `best_single` | The cheapest app that carries every item, or `null` if none does |
| `savings` | `best_single.total - total`, or `null` when there is no single-app comparison |
| `free_delivery_gap` | How far a cart is below its free-delivery line, or `null` |
| `method` | `exhaustive`, `ilp`, or `none` when nothing was available |
| `kept_single_app` | `true` when a cheaper split existed but did not clear `min_split_saving` |

## Mock store APIs

These exist so the demo works offline. **Their shapes are invented**; they are not
the real apps' formats. Each store answers search differently on purpose, to give
the adapters something real to normalise.

| Store | Search | Shape |
|---|---|---|
| zepto | `GET /mock/zepto/api/v3/search?query=` | `layout[].data.resolver.data.items[].productResponse`, prices in paise |
| blinkit | `GET /mock/blinkit/api/v1/layout/search?q=` | `response.snippets[].data`, values wrapped as `{ "text": ... }`, prices like `"₹68"` |
| instamart | `POST /mock/instamart/api/instamart/search` with `{ "query": "" }` | `data.widgets[].data[]` with a `variations[]` array |

Shared by all three:

| Method | Path | Purpose |
|---|---|---|
| GET | `/mock/{store}/api/home` | Featured products, in that store's search shape |
| GET | `/mock/{store}/api/config` | Label, ETA and fees |
| GET | `/mock/{store}/api/cart` | The current cart with its bill |
| POST | `/mock/{store}/api/cart` | `{ "product_id": "...", "delta": 1 }`. Returns `409 OUT_OF_STOCK` or `404 NOT_FOUND` as errors |
| DELETE | `/mock/{store}/api/cart` | Empty the cart |

Carts are kept in memory per browser session (a `cp_sid` cookie) and vanish when
the backend restarts.

## CORS

Requests are accepted from `chrome-extension://` origins and from
`http://localhost` / `http://127.0.0.1` on any port. Nothing else.
