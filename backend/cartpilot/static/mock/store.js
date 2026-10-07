// Mock storefront. This is the "site's own code": it calls its own APIs with fetch,
// exactly the traffic the CartPilot page hook is designed to observe.
(() => {
  const store = window.MOCK_STORE;
  const base = `/mock/${store}/api`;
  const $ = (id) => document.querySelector(`[data-testid="${id}"]`);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const rupee = (n) => `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const state = { products: [], cart: { items: [], count: 0 }, config: null };

  // Each store answers in its own shape, so each needs its own reader.
  const READERS = {
    zepto: (json) =>
      json.layout.flatMap((w) => w.data.resolver.data.items).map(({ productResponse: p }) => ({
        id: p.id, name: p.product.name, size: p.productVariant.formattedPacksize, price: p.sellingPrice / 100,
        mrp: p.productVariant.mrp / 100, inStock: !p.outOfStock, emoji: p.meta.emoji,
      })),
    blinkit: (json) =>
      json.response.snippets.map(({ data: d }) => ({
        id: d.identity.id, name: d.name.text, size: d.variant.text, price: Number(d.normal_price.text.replace("₹", "")),
        mrp: Number(d.mrp.text.replace("₹", "")), inStock: !d.is_sold_out, emoji: d.image.emoji,
      })),
    instamart: (json) =>
      json.data.widgets.flatMap((w) => w.data).map((p) => ({
        id: p.product_id, name: p.display_name, size: p.variations[0].quantity, price: p.variations[0].price.offer_price,
        mrp: p.variations[0].price.mrp, inStock: p.variations[0].inventory.in_stock, emoji: p.emoji,
      })),
  };
  const SEARCH = {
    zepto: (q) => fetch(`${base}/v3/search?query=${encodeURIComponent(q)}`),
    blinkit: (q) => fetch(`${base}/v1/layout/search?q=${encodeURIComponent(q)}`),
    instamart: (q) => fetch(`${base}/instamart/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) }),
  };

  let toastTimer;
  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  const qtyOf = (id) => (state.cart.items.find((i) => i.product_id === id) || {}).quantity || 0;

  function renderGrid() {
    const grid = $("results");
    if (!state.products.length) {
      grid.innerHTML = `<p class="empty" data-testid="no-results">No products found. Try another search.</p>`;
      return;
    }
    grid.innerHTML = state.products
      .map((p) => {
        const qty = qtyOf(p.id);
        const action = !p.inStock
          ? `<button class="add" data-testid="sold-out" disabled>Out of stock</button>`
          : qty
            ? `<span class="stepper"><button data-testid="qty-dec" data-delta="-1" aria-label="Remove one">−</button><span data-testid="qty-value">${qty}</span><button data-testid="qty-inc" data-delta="1" aria-label="Add one more">+</button></span>`
            : `<button class="add" data-testid="add-button" data-delta="1">ADD</button>`;
        return `<article class="card${p.inStock ? "" : " sold"}" data-testid="product-card" data-product-id="${esc(p.id)}">
          <div class="pic" aria-hidden="true">${esc(p.emoji)}</div>
          <div class="name">${esc(p.name)}</div>
          <div class="size">${esc(p.size)}</div>
          <div class="row"><span class="price">${rupee(p.price)}${p.mrp > p.price ? `<span class="mrp">${rupee(p.mrp)}</span>` : ""}</span>${action}</div>
        </article>`;
      })
      .join("");
  }

  function renderCart() {
    const c = state.cart;
    $("cart-count").textContent = c.count;
    $("cart-lines").innerHTML = c.items.length
      ? c.items
          .map((i) => `<div class="line" data-testid="cart-line" data-product-id="${esc(i.product_id)}"><span class="e">${esc(i.emoji)}</span>
            <span class="t">${esc(i.name)}<small>${esc(i.size)} · ${rupee(i.unit_price)} × ${i.quantity}</small></span><strong>${rupee(i.line_total)}</strong></div>`)
          .join("")
      : `<p class="empty">Your cart is empty.</p>`;
    if (!c.items.length) return ($("cart-bill").innerHTML = "");
    const fees = (state.config && state.config.fees) || {};
    const gap = fees.free_delivery_threshold != null && c.delivery_fee > 0 ? fees.free_delivery_threshold - c.subtotal : 0;
    $("cart-bill").innerHTML = `
      <div class="bill"><span>Item total</span><span>${rupee(c.subtotal)}</span></div>
      <div class="bill"><span>Delivery fee</span><span>${c.delivery_fee ? rupee(c.delivery_fee) : '<span class="free">FREE</span>'}</span></div>
      <div class="bill"><span>Handling fee</span><span>${rupee(c.handling_fee)}</span></div>
      ${c.small_cart_fee ? `<div class="bill"><span>Small cart fee</span><span>${rupee(c.small_cart_fee)}</span></div>` : ""}
      <div class="bill total"><span>To pay</span><span data-testid="cart-total">${rupee(c.total)}</span></div>
      ${gap > 0 ? `<p class="hint">Add ${rupee(gap)} more for free delivery.</p>` : ""}
      <button class="pay" data-testid="pay-button" type="button">Proceed to pay</button>
      <button class="link" data-testid="cart-clear" type="button">Empty cart</button>`;
  }

  async function runSearch(query) {
    const q = query.trim();
    const res = q ? await SEARCH[store](q) : await fetch(`${base}/home`);
    state.products = READERS[store](await res.json());
    $("heading").textContent = q ? `Results for “${q}”` : "Popular right now";
    renderGrid();
  }

  async function changeCart(productId, delta) {
    const res = await fetch(`${base}/cart`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: productId, delta }) });
    const body = await res.json();
    if (!res.ok) return toast((body.error && body.error.message) || "Could not update the cart.");
    state.cart = body.cart;
    renderGrid();
    renderCart();
  }

  function openCart(open) {
    $("cart-drawer").hidden = !open;
    $("scrim").hidden = !open;
  }

  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch($("search-input").value).catch(() => toast("Search failed."));
  });
  $("results").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-delta]");
    if (!button) return;
    changeCart(button.closest("[data-product-id]").dataset.productId, Number(button.dataset.delta)).catch(() => toast("Could not update the cart."));
  });
  $("cart-button").addEventListener("click", () => openCart($("cart-drawer").hidden));
  $("cart-close").addEventListener("click", () => openCart(false));
  $("scrim").addEventListener("click", () => openCart(false));
  $("cart-bill").addEventListener("click", async (event) => {
    if (event.target.closest('[data-testid="pay-button"]')) toast("Demo store: there is no payment here. On a real app you pay yourself.");
    if (event.target.closest('[data-testid="cart-clear"]')) {
      state.cart = (await (await fetch(`${base}/cart`, { method: "DELETE" })).json()).cart;
      renderGrid();
      renderCart();
    }
  });

  (async () => {
    state.config = await (await fetch(`${base}/config`)).json();
    state.cart = (await (await fetch(`${base}/cart`)).json()).cart;
    renderCart();
    await runSearch("");
  })().catch(() => toast("Could not load the store."));
})();
