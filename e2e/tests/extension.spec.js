// The real Chrome extension, loaded unpacked into Chromium: content scripts in real
// tabs, the page hook in the page's own world, and the side-panel UI as an extension page.
const { test, expect, chromium } = require("@playwright/test");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { STORES, waitForPhase, storeCart } = require("./helpers");

const EXTENSION = path.resolve(__dirname, "..", "..", "extension");
const LIST = "12 eggs, amul butter 500g, britannia bread, aashirvaad atta 5kg, toor dal 1kg, onion 1kg, 2 maggi 70g, fortune sunflower oil 1L, tata tea gold 500g, surf excel 1kg";

let context;
let extensionId;
let profile;

test.beforeAll(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "cartpilot-e2e-"));
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", // the new headless mode, which can load extensions
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    viewport: { width: 420, height: 900 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

test("manifest is MV3 and asks only for what it needs", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8"));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions.sort()).toEqual(["sidePanel", "storage", "tabs"]);
  for (const forbidden of ["cookies", "webRequest", "declarativeNetRequest", "proxy", "debugger", "<all_urls>"]) {
    expect(JSON.stringify(manifest)).not.toContain(forbidden);
  }
  expect(manifest.content_scripts[0]).toMatchObject({ world: "MAIN", run_at: "document_start", js: ["src/page-hook.js"] });
});

test("side panel drives real store tabs: collect in the background, fill with the tab in front", async () => {
  const tabs = {};
  for (const store of STORES) {
    tabs[store] = await context.newPage();
    await tabs[store].goto(`http://localhost:8000/mock/${store}/`);
    await expect(tabs[store].locator('[data-testid="product-card"]').first()).toBeVisible();
    await tabs[store].evaluate((s) => fetch(`/mock/${s}/api/cart`, { method: "DELETE" }), store);
    await tabs[store].reload();
    await expect(tabs[store].locator('[data-testid="product-card"]').first()).toBeVisible();
    // The hook lives in the page's world; the content script does not leak into it.
    expect(await tabs[store].evaluate(() => [window.__cartpilotHook === true, typeof window.__cartpilotContent])).toEqual([true, "undefined"]);
  }

  const panel = await context.newPage();
  panel.on("pageerror", (error) => {
    throw error;
  });
  await panel.goto(`chrome-extension://${extensionId}/panel/index.html`);
  await expect(panel.locator("#mode-pill")).toHaveText("Demo · mock stores");
  await expect(panel.locator("#backend-status")).toContainText("Backend ready");
  await panel.waitForFunction(() => Object.values(window.__cartpilot.state.stores).filter((s) => s.connected).length === 3, null, { timeout: 20_000 });
  await expect(panel.locator("#live")).toBeHidden(); // no iframes in the extension: the real tabs are the live view

  await panel.fill("#list-input", LIST);
  await panel.click("#go");
  await waitForPhase(panel, "plan");

  const plan = await panel.evaluate(() => window.__cartpilot.state.plan);
  const feeSource = await panel.evaluate(() => window.__cartpilot.state.feeSource);
  expect(feeSource).toEqual({ zepto: "store", blinkit: "store", instamart: "store" }); // read from the page's own config call
  expect(plan.unfulfilled).toEqual([]);
  expect(plan.carts.length).toBeGreaterThan(1);
  expect(plan.savings).toBeGreaterThan(0);
  for (const store of STORES) expect((await storeCart(tabs[store], store)).count).toBe(0); // collecting never touches a cart

  await panel.click('[data-action="fill"]');
  await waitForPhase(panel, "done", 150_000);

  const fill = await panel.evaluate(() => window.__cartpilot.state.fill);
  for (const cart of plan.carts) {
    for (const line of cart.lines) expect([line.product_name, fill[line.item_id].status, fill[line.item_id].verified]).toEqual([line.product_name, "added", "network"]);
    const real = await storeCart(tabs[cart.app], cart.app);
    expect(real.items.map((i) => [i.product_id, i.quantity]).sort()).toEqual(cart.lines.map((l) => [l.product_id, l.quantity]).sort());
    expect(real.total).toBe(cart.total);
    // What the user sees in the store tab agrees: steppers on the cards, count on the cart button.
    await expect(tabs[cart.app].locator('[data-testid="cart-count"]')).toHaveText(String(cart.lines.reduce((n, l) => n + l.quantity, 0)));
  }
  const maggi = plan.carts.flatMap((c) => c.lines).find((l) => l.item_id === "item-7");
  expect(maggi.quantity).toBe(2);

  await panel.locator('[data-action="show-cart"]').first().click();
  await expect(tabs[plan.carts[0].app].locator('[data-testid="cart-drawer"]')).toBeVisible();
  await expect(tabs[plan.carts[0].app].locator('[data-testid="pay-button"]')).toBeVisible(); // present, and never clicked by CartPilot
});

test("setup recorder captures one search and one Add, trimmed and scrubbed", async () => {
  const tab = context.pages().find((p) => p.url().includes("/mock/zepto/")) || (await context.newPage());
  if (!tab.url().includes("/mock/zepto/")) await tab.goto("http://localhost:8000/mock/zepto/");
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel/index.html`);
  const record = (cmd) =>
    panel.evaluate(async (c) => {
      const [t] = await chrome.tabs.query({ url: "http://localhost:8000/mock/zepto/*" });
      return chrome.tabs.sendMessage(t.id, { target: "cartpilot-recorder", cmd: c });
    }, cmd);

  expect(await record("start")).toEqual({ ok: true, recording: true });
  await tab.bringToFront();
  await tab.fill('[data-testid="search-input"]', "milk");
  await tab.press('[data-testid="search-input"]', "Enter");
  await expect(tab.locator('[data-testid="heading"]')).toContainText("milk");
  // A response with personal fields, as a real store might return.
  await tab.evaluate(() => fetch("/mock/zepto/api/config?phone=9999999999&q=ok"));
  await tab.locator('[data-testid="add-button"]').first().click();
  await expect(tab.locator('[data-testid="qty-value"]').first()).toHaveText("1");
  await tab.reload(); // the recording must survive a page reload
  expect((await record("status")).recording).toBe(true);

  const { ok, data } = await record("stop");
  expect(ok).toBe(true);
  expect([data.store, data.host]).toEqual(["zepto", "localhost:8000"]);
  const search = data.responses.find((r) => r.url.includes("/api/v3/search"));
  expect(search.url).toContain("query=milk");
  const items = search.body.layout[0].data.resolver.data.items;
  expect(items.length).toBe(4); // three samples plus a "+N more" note, not the whole list
  expect(items[3]).toMatch(/more like these/);
  expect(items[0].productResponse.product.name).toContain("Milk");
  const cart = data.responses.find((r) => r.method === "POST" && r.url.endsWith("/api/cart"));
  expect(cart.requestBody).toEqual({ product_id: expect.any(String), delta: 1 });
  expect(data.responses.find((r) => r.url.includes("/api/config?")).url).toContain("phone=%5Bremoved%5D");
  const typed = data.actions.find((a) => a.kind === "typed");
  expect(typed.element[0].attrs["data-testid"]).toBe("search-input");
  expect(typed.element[0].attrs.value).toBeUndefined(); // what was typed is not stored
  const clicked = data.actions.filter((a) => a.kind === "clicked").map((a) => a.element[0].attrs["data-testid"]);
  expect(clicked).toContain("add-button");
  expect(JSON.stringify(data)).not.toMatch(/cookie|authorization/i);
  expect((await record("status")).recording).toBe(false);
  await tab.evaluate(() => fetch("/mock/zepto/api/cart", { method: "DELETE" }));
  await panel.close();
});

test("with no store tab open the panel says so and offers to open them", async () => {
  for (const page of context.pages()) if (page.url().includes("/mock/")) await page.close();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel/index.html`);
  await expect(panel.locator('.stores [data-action="open-store"]')).toHaveCount(3);
  await panel.fill("#list-input", "milk");
  await panel.click("#go");
  await expect(panel.locator(".toast.error")).toContainText("No store tab is open");
  await panel.locator('.stores li[data-store="blinkit"] [data-action="open-store"]').click();
  await panel.waitForFunction(() => window.__cartpilot.state.stores.blinkit.connected === true, null, { timeout: 15_000 });
  await expect(panel.locator('.stores li[data-store="blinkit"] .s-status')).toHaveText("Ready");
});
