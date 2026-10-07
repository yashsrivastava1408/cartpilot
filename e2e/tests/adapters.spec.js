// Adapter logic on its own (no browser): normalize() for each mock shape, the
// heuristic normaliser used by the live scaffolds, and which pages each adapter claims.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = { URL, CSS: { escape: (s) => s } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../extension/src/adapters.js"), "utf8"), sandbox);
const CP = sandbox.CartPilot;
const adapter = (id) => CP.adapters.find((a) => a.id === id);
const loc = (url) => new URL(url);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("each mock normalize() reads its store's live response into the common shape", async ({ request }) => {
  const z = await (await request.get("/mock/zepto/api/v3/search?query=amul%20milk%201%20l")).json();
  const b = await (await request.get("/mock/blinkit/api/v1/layout/search?q=amul%20milk%201%20l")).json();
  const i = await (await request.post("/mock/instamart/api/instamart/search", { data: { query: "amul milk 1 l" } })).json();
  const [zp] = adapter("mock-zepto").search.normalize(z);
  const [bp] = adapter("mock-blinkit").search.normalize(b);
  const [ip] = adapter("mock-instamart").search.normalize(i);
  expect(plain(zp)).toEqual({ id: "z-amul-taaza-1l", app: "zepto", name: "Amul Taaza Toned Milk", brand: "Amul", size_text: "1 L", price: 68, mrp: 72, in_stock: true, image: "🥛", rank: 0 });
  expect(plain(bp)).toMatchObject({ id: "b-amul-taaza-1l", app: "blinkit", name: "Amul Taaza Homogenised Toned Milk", size_text: "1 ltr", price: 70, mrp: 72, rank: 0 });
  expect(plain(ip)).toMatchObject({ id: "i-amul-taaza-1l", app: "instamart", price: 69, mrp: 72, in_stock: true });

  const hing = adapter("mock-zepto").search.normalize(await (await request.get("/mock/zepto/api/v3/search?query=catch%20hing")).json());
  expect(hing.find((p) => p.id === "z-catch-hing-50g").in_stock).toBe(false);
});

test("normalize() survives junk without throwing or inventing products", () => {
  for (const id of ["mock-zepto", "mock-blinkit", "mock-instamart"]) {
    expect(plain(adapter(id).search.normalize({}))).toEqual([]);
  }
  const mixed = { response: { snippets: [{ data: null }, { data: { identity: { id: "x" }, name: { text: "Ok" }, normal_price: { text: "₹1,250.50" } } }, {}] } };
  expect(plain(adapter("mock-blinkit").search.normalize(mixed))).toMatchObject([{ id: "x", name: "Ok", price: 1250.5, mrp: null, in_stock: true, rank: 0 }]);
  expect(CP.util.makeProduct("a", { id: 1, name: "No price", price: "free" }, 0)).toBeNull();
  expect(CP.util.makeProduct("a", { id: "", name: "No id", price: 5 }, 0)).toBeNull();
  expect(CP.util.makeProduct("a", { id: 1, name: "Neg", price: -5 }, 0)).toBeNull();
});

test("heuristic normaliser finds products in an unknown shape", () => {
  const unknown = {
    page: { sections: [{ cards: [
      { productId: "p1", productName: "Fresh Paneer", sellingPrice: 9200, mrp: 9800, formattedPacksize: "200 g", outOfStock: false },
      { productId: "p2", productName: "Brown Bread", sellingPrice: 4500, outOfStock: true },
      { productId: "p1", productName: "Fresh Paneer", sellingPrice: 9200 },
      { title: "A banner, not a product" },
    ] }] },
  };
  const found = plain(CP.util.heuristicNormalize(unknown, { app: "zepto", priceDivisor: 100 }));
  expect(found).toMatchObject([
    { id: "p1", name: "Fresh Paneer", price: 92, mrp: 98, size_text: "200 g", in_stock: true, rank: 0 },
    { id: "p2", name: "Brown Bread", price: 45, in_stock: false, rank: 1 },
  ]);
});

test("each adapter claims only its own pages", () => {
  const pick = (url) => (CP.pickAdapter(loc(url)) || {}).id || null;
  expect(pick("http://localhost:8000/mock/zepto/")).toBe("mock-zepto");
  expect(pick("http://127.0.0.1:8000/mock/instamart/")).toBe("mock-instamart");
  expect(pick("https://www.zepto.com/search?query=milk")).toBe("zepto");
  expect(pick("https://www.zeptonow.com/")).toBe("zepto");
  expect(pick("https://blinkit.com/s/?q=milk")).toBe("blinkit");
  expect(pick("https://www.swiggy.com/instamart/search")).toBe("instamart");
  expect(pick("https://www.swiggy.com/restaurants")).toBeNull(); // Swiggy food is not Instamart
  expect(pick("https://evil-zepto.com.example.org/")).toBeNull();
  expect(pick("http://localhost:8000/app/")).toBeNull();
  expect(pick("https://example.com/mock/zepto/")).toBeNull();
});

test("live adapters are marked as scaffolds and mock adapters are complete", () => {
  for (const id of ["zepto", "blinkit", "instamart"]) {
    const a = adapter(id);
    expect([a.mock, a.submit, typeof a.defaultFees.delivery_fee]).toEqual([false, "enter", "number"]);
  }
  for (const id of ["mock-zepto", "mock-blinkit", "mock-instamart"]) expect(adapter(id).mock).toBe(true);
  const cart = adapter("mock-zepto").cart;
  expect(plain(cart.parse({ cart: { items: [{ product_id: "a", quantity: 2 }] } }, 200))).toEqual({ ok: true, code: null, quantities: { a: 2 } });
  expect(plain(cart.parse({ error: { code: "OUT_OF_STOCK" } }, 409))).toEqual({ ok: false, code: "OUT_OF_STOCK", quantities: {} });
});
