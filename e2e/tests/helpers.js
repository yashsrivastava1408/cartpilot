const { expect } = require("@playwright/test");

const STORES = ["zepto", "blinkit", "instamart"];
const state = (page, fn) => page.evaluate(fn);
const phase = (page) => page.evaluate(() => window.__cartpilot.state.phase);

async function waitForPhase(page, wanted, timeout = 90_000) {
  await page.waitForFunction((w) => [].concat(w).includes(window.__cartpilot.state.phase), wanted, { timeout });
}

async function openApp(page, url = "/app/") {
  await page.goto(url);
  await page.waitForFunction(() => Object.values(window.__cartpilot.state.stores).filter((s) => s.connected).length === 3, null, { timeout: 20_000 });
  await expect(page.locator("#backend-status")).toContainText("Backend ready");
}

async function runList(page, text) {
  await page.fill("#list-input", text);
  await page.click("#go");
}

/** Pick the option with the given label for an item that is asking "which one?". */
async function pick(page, itemId, label) {
  await page.locator(`.r-item[data-item="${itemId}"] .option`, { hasText: label }).first().click();
}

/** Cart of a mock store as the storefront itself reports it, read from inside `page` (same session cookie). */
async function storeCart(page, store) {
  return page.evaluate(async (s) => (await (await fetch(`http://localhost:8000/mock/${s}/api/cart`, { credentials: "include" })).json()).cart, store);
}

async function emptyCarts(page) {
  for (const store of STORES) await page.evaluate((s) => fetch(`http://localhost:8000/mock/${s}/api/cart`, { method: "DELETE", credentials: "include" }), store);
}

module.exports = { STORES, state, phase, waitForPhase, openApp, runList, pick, storeCart, emptyCarts };
