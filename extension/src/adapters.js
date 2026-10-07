/*
 * CartPilot store adapters.
 *
 * One adapter per storefront. An adapter says: which pages it handles, where the
 * search box and Add buttons are, which of the site's own JSON responses carry
 * search results, and how to normalise() them into CartPilot's common product shape:
 *
 *   { id, app, name, brand, size_text, price, mrp, in_stock, image, rank }
 *
 * The three mock adapters are complete and tested. The three live adapters are
 * scaffolds: every place that needs a real value from DevTools is marked TODO(devtools).
 */
(() => {
  const CP = (globalThis.CartPilot = globalThis.CartPilot || {});
  CP.VERSION = "1.0.0";

  // ------------------------------------------------------------ helpers

  const toNumber = (value) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return NaN;
    const m = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  };

  const dig = (obj, path) => path.split(".").reduce((o, key) => (o == null ? undefined : o[key]), obj);

  const pathOf = (url) => {
    try {
      return new URL(url).pathname;
    } catch {
      return String(url);
    }
  };

  /** Build one normalised product, or null if the raw record is unusable. */
  function makeProduct(app, raw, rank) {
    const price = toNumber(raw.price);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (raw.id == null || raw.id === "" || !name || !Number.isFinite(price) || price < 0) return null;
    const mrp = toNumber(raw.mrp);
    return {
      id: String(raw.id),
      app,
      name: name.slice(0, 300),
      brand: raw.brand ? String(raw.brand).trim().slice(0, 120) || null : null,
      size_text: raw.size_text ? String(raw.size_text).trim().slice(0, 80) || null : null,
      price: Math.round(price * 100) / 100,
      mrp: Number.isFinite(mrp) && mrp >= price ? Math.round(mrp * 100) / 100 : null,
      in_stock: raw.in_stock !== false,
      image: raw.image ? String(raw.image).slice(0, 2000) : null,
      rank,
    };
  }

  const collectProducts = (app, records, mapper) => {
    const out = [];
    for (const record of records || []) {
      let product = null;
      try {
        product = makeProduct(app, mapper(record), out.length);
      } catch {
        product = null; // one malformed record must not lose the rest
      }
      if (product) out.push(product);
    }
    return out;
  };

  /**
   * Best-effort normaliser for a response whose shape is not yet known: walk the
   * JSON and keep every object that looks like a product (a name plus a price).
   * Good enough to get started on a live site; replace with exact paths once you
   * have looked at the real response in DevTools.
   */
  function heuristicNormalize(json, { app, priceDivisor = 1 }) {
    const NAME = ["name", "product_name", "productName", "display_name", "displayName", "title"];
    const PRICE = ["sellingPrice", "selling_price", "discountedSellingPrice", "offer_price", "offerPrice", "final_price", "price", "sp"];
    const MRP = ["mrp", "marked_price", "markedPrice", "maxRetailPrice"];
    const ID = ["id", "product_id", "productId", "objectId", "sku", "variant_id"];
    const SIZE = ["formattedPacksize", "packsize", "pack_size", "unit", "quantity", "weight", "variant", "size"];
    const first = (o, keys, test) => {
      for (const k of keys) if (test(o[k])) return o[k];
      return undefined;
    };
    const str = (v) => typeof v === "string" && v.trim().length > 1;
    const priceLike = (v) => Number.isFinite(toNumber(v)) && toNumber(v) > 0 && typeof v !== "object";

    const seen = new Set();
    const found = [];
    let visited = 0;
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 14 || ++visited > 30000) return;
      if (Array.isArray(node)) return node.forEach((child) => walk(child, depth + 1));
      const name = first(node, NAME, str);
      const price = first(node, PRICE, priceLike);
      const id = first(node, ID, (v) => typeof v === "string" || typeof v === "number");
      if (name && price !== undefined && id !== undefined && !seen.has(String(id))) {
        seen.add(String(id));
        const stockFlags = [node.outOfStock, node.out_of_stock, node.is_sold_out, node.sold_out];
        found.push({
          id,
          name,
          brand: first(node, ["brand", "brand_name", "brandName"], str),
          size_text: first(node, SIZE, (v) => str(v) && /\d/.test(v)),
          price: toNumber(price) / priceDivisor,
          mrp: toNumber(first(node, MRP, priceLike)) / priceDivisor,
          in_stock: !stockFlags.some((f) => f === true) && node.in_stock !== false && node.available !== false,
          image: first(node, ["image", "image_url", "imageUrl", "thumbnail"], str),
        });
      }
      Object.values(node).forEach((child) => walk(child, depth + 1));
    };
    walk(json, 0);
    return collectProducts(app, found, (r) => r);
  }

  // ------------------------------------------------------------ mock adapters (complete)

  const MOCK_SELECTORS = {
    searchInput: ['[data-testid="search-input"]'],
    productCard: '[data-testid="product-card"]',
    addButton: '[data-testid="add-button"]',
    incButton: '[data-testid="qty-inc"]',
    qtyValue: '[data-testid="qty-value"]',
    soldOut: '[data-testid="sold-out"]',
    cartButton: '[data-testid="cart-button"]',
  };

  function mockAdapter({ store, label, searchPath, normalize }) {
    return {
      id: `mock-${store}`,
      store,
      label: `${label} (mock)`,
      mock: true,
      matches: (loc) => /^(localhost|127\.0\.0\.1)$/.test(loc.hostname) && loc.pathname.startsWith(`/mock/${store}/`),
      selectors: MOCK_SELECTORS,
      submit: "form",
      search: { isResponse: (url) => pathOf(url).endsWith(searchPath), normalize },
      cart: {
        isResponse: (url) => pathOf(url).endsWith("/api/cart"),
        parse: (body, status) => ({
          ok: status < 400,
          code: (body && body.error && body.error.code) || null,
          quantities: Object.fromEntries(((body && body.cart && body.cart.items) || []).map((i) => [i.product_id, i.quantity])),
        }),
      },
      config: { isResponse: (url) => pathOf(url).endsWith("/api/config"), parseFees: (body) => body.fees },
      defaultFees: null,
      cardFor: (doc, line) => doc.querySelector(`[data-product-id="${CSS.escape(line.productId)}"]`),
    };
  }

  const mockZepto = mockAdapter({
    store: "zepto",
    label: "Zepto",
    searchPath: "/api/v3/search",
    // Mock shape: layout[].data.resolver.data.items[].productResponse, prices in paise.
    normalize: (json) =>
      collectProducts(
        "zepto",
        (json.layout || []).flatMap((w) => dig(w, "data.resolver.data.items") || []),
        ({ productResponse: p }) => ({
          id: p.id,
          name: p.product.name,
          brand: p.product.brand,
          size_text: p.productVariant.formattedPacksize,
          price: p.sellingPrice / 100,
          mrp: p.productVariant.mrp / 100,
          in_stock: !p.outOfStock,
          image: dig(p, "meta.emoji"),
        }),
      ),
  });

  const mockBlinkit = mockAdapter({
    store: "blinkit",
    label: "Blinkit",
    searchPath: "/api/v1/layout/search",
    // Mock shape: response.snippets[].data, every value wrapped as { text }, prices like "₹68".
    normalize: (json) =>
      collectProducts("blinkit", dig(json, "response.snippets") || [], ({ data: d }) => ({
        id: d.identity.id,
        name: d.name.text,
        brand: dig(d, "brand_name.text"),
        size_text: dig(d, "variant.text"),
        price: toNumber(d.normal_price.text),
        mrp: toNumber(dig(d, "mrp.text")),
        in_stock: !d.is_sold_out,
        image: dig(d, "image.emoji"),
      })),
  });

  const mockInstamart = mockAdapter({
    store: "instamart",
    label: "Instamart",
    searchPath: "/api/instamart/search",
    // Mock shape: data.widgets[].data[] with a variations[] array; the first variation is the listing.
    normalize: (json) =>
      collectProducts(
        "instamart",
        (dig(json, "data.widgets") || []).filter((w) => w.type === "PRODUCT_LIST").flatMap((w) => w.data || []),
        (p) => {
          const v = p.variations[0];
          return {
            id: p.product_id,
            name: p.display_name,
            brand: p.brand,
            size_text: v.quantity,
            price: v.price.offer_price,
            mrp: v.price.mrp,
            in_stock: v.inventory.in_stock,
            image: p.emoji,
          };
        },
      ),
  });

  // ------------------------------------------------------------ live adapters (scaffolds)
  //
  // How to finish one of these:
  //   1. Open the store, log in, set your address. Open DevTools -> Network -> Fetch/XHR.
  //   2. Search for something. Find the request that returns the product list.
  //   3. Put a pattern for its URL in search.isResponse and the real field paths in
  //      search.normalize (copy the style of the mock adapters above).
  //   4. Inspect the search box and an "Add" button; put their selectors in `selectors`.
  //   5. Add an item by hand, find the cart request, and fill in cart.isResponse / cart.parse.
  //
  // Until then each adapter runs on generic fallbacks (heuristicNormalize + text-based
  // button lookup). These are unverified against the real sites.
  //
  // The fees below are placeholders, not the stores' real fees. Check the bill
  // details at checkout and correct them in the panel under "Fees".

  const GENERIC_SELECTORS = {
    searchInput: ['input[type="search"]', 'input[placeholder*="earch" i]', 'input[aria-label*="earch" i]'],
    searchTrigger: ['a[href*="/search"]', '[data-testid*="search" i]', '[aria-label*="search" i]'],
    productCard: null,
    addButton: null,
    incButton: null,
    qtyValue: null,
    soldOut: null,
    cartButton: null,
  };

  const liveAdapter = (config) => ({
    mock: false,
    submit: "enter",
    selectors: { ...GENERIC_SELECTORS },
    cart: {
      // TODO(devtools): narrow to the real add-to-cart endpoint and read real quantities.
      isResponse: (url, method) => method !== "GET" && /cart/i.test(pathOf(url)),
      parse: (body, status) => ({ ok: status < 400, code: null, quantities: null }),
    },
    config: null,
    cardFor: null, // null = find the card by its visible product name
    ...config,
  });

  const zepto = liveAdapter({
    id: "zepto",
    store: "zepto",
    label: "Zepto",
    matches: (loc) => /(^|\.)zepto(now)?\.com$/.test(loc.hostname),
    search: {
      // TODO(devtools): replace with the exact search endpoint path.
      isResponse: (url) => /search/i.test(pathOf(url)),
      // TODO(devtools): replace with exact paths. If prices come back in paise, set priceDivisor: 100.
      normalize: (json) => heuristicNormalize(json, { app: "zepto", priceDivisor: 1 }),
    },
    defaultFees: { delivery_fee: 30, free_delivery_threshold: 199, handling_fee: 10, small_cart_fee: 0, small_cart_threshold: 0 },
  });

  const blinkit = liveAdapter({
    id: "blinkit",
    store: "blinkit",
    label: "Blinkit",
    matches: (loc) => /(^|\.)blinkit\.com$/.test(loc.hostname),
    search: {
      // TODO(devtools): replace with the exact search endpoint path.
      isResponse: (url) => /search/i.test(pathOf(url)),
      // TODO(devtools): replace with exact paths.
      normalize: (json) => heuristicNormalize(json, { app: "blinkit", priceDivisor: 1 }),
    },
    defaultFees: { delivery_fee: 25, free_delivery_threshold: 199, handling_fee: 10, small_cart_fee: 0, small_cart_threshold: 0 },
  });

  const instamart = liveAdapter({
    id: "instamart",
    store: "instamart",
    label: "Instamart",
    matches: (loc) => /(^|\.)swiggy\.com$/.test(loc.hostname) && loc.pathname.startsWith("/instamart"),
    search: {
      // TODO(devtools): replace with the exact search endpoint path.
      isResponse: (url) => /instamart/i.test(pathOf(url)) && /search/i.test(pathOf(url)),
      // TODO(devtools): replace with exact paths. If prices come back in paise, set priceDivisor: 100.
      normalize: (json) => heuristicNormalize(json, { app: "instamart", priceDivisor: 1 }),
    },
    defaultFees: { delivery_fee: 30, free_delivery_threshold: 199, handling_fee: 10, small_cart_fee: 0, small_cart_threshold: 0 },
  });

  CP.adapters = [mockZepto, mockBlinkit, mockInstamart, zepto, blinkit, instamart];
  CP.pickAdapter = (loc) => CP.adapters.find((a) => a.matches(loc)) || null;
  CP.util = { toNumber, dig, pathOf, makeProduct, heuristicNormalize };
})();
