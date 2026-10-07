// The web demo: mock stores in iframes, driven by the same driver the extension uses.
const { test, expect } = require("@playwright/test");
const { STORES, waitForPhase, openApp, runList, pick, storeCart, emptyCarts } = require("./helpers");

const WEEKEND = "12 eggs, amul butter 500g, britannia bread, aashirvaad atta 5kg, toor dal 1kg, onion 1kg, tomato 1kg, fortune sunflower oil 1L, tata tea gold 500g, surf excel 1kg";
const WEEKLY = "1L amul milk, eggs, 2 maggi, aashirvaad atta 5kg, onion 1kg, britannia bread, catch hing";

let pageErrors;
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));
  await openApp(page);
  await emptyCarts(page);
});

test.afterEach(() => {
  expect(pageErrors, "uncaught errors in the page or a store frame").toEqual([]);
});

test("clear list: prices, plan with savings, carts really filled", async ({ page }) => {
  await runList(page, WEEKEND);
  await waitForPhase(page, "plan");

  const plan = await page.evaluate(() => window.__cartpilot.state.plan);
  expect(plan.unfulfilled).toEqual([]);
  expect(plan.carts.length).toBeGreaterThan(1);
  expect(plan.savings).toBeGreaterThan(0);
  expect(plan.total).toBeLessThan(plan.best_single.total);
  await expect(page.locator(".hero h2")).toHaveText(`You save ₹${plan.savings}`);
  await expect(page.locator(".cart")).toHaveCount(plan.carts.length);
  await expect(page.locator(".cmp.best .c-total")).toContainText(plan.total.toLocaleString("en-IN"));

  await page.click('[data-action="fill"]');
  await waitForPhase(page, "done");

  const fill = await page.evaluate(() => window.__cartpilot.state.fill);
  for (const cart of plan.carts) {
    for (const line of cart.lines) {
      expect(fill[line.item_id].status, line.product_name).toBe("added");
      expect(fill[line.item_id].verified).toBe("network");
    }
    // The storefront's own cart must hold exactly the planned products and charge the planned total.
    const real = await storeCart(page, cart.app);
    expect(real.items.map((i) => [i.product_id, i.quantity]).sort()).toEqual(cart.lines.map((l) => [l.product_id, l.quantity]).sort());
    expect(real.total).toBe(cart.total);
  }
  for (const store of STORES.filter((s) => !plan.carts.some((c) => c.app === s))) expect((await storeCart(page, store)).count).toBe(0);
  await expect(page.locator("#fill-summary")).toHaveText(`${plan.carts.flatMap((c) => c.lines).length} of ${plan.carts.flatMap((c) => c.lines).length} added`);
  await expect(page.locator(".pay-note")).toContainText("CartPilot never pays");
});

test("ambiguous list: which-one chips, substitute, skip, quantity", async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await runList(page, WEEKLY);
  await waitForPhase(page, "review");

  await expect(page.locator(".r-item.ask")).toHaveCount(4); // milk, eggs, maggi, hing
  await expect(page.locator("#sec-plan")).toBeHidden();
  await expect(page.locator('.r-item[data-item="item-7"] .badge.ask')).toHaveText("Out of stock · substitute?");
  await expect(page.locator('.r-item[data-item="item-7"] .badge.sub')).toContainText("different brand");
  await expect(page.locator('.r-item[data-item="item-4"] .picked')).toContainText("Aashirvaad Shudh Chakki Atta");

  await pick(page, "item-1", "Amul Gold Full Cream Milk");
  await pick(page, "item-2", "12 pcs");
  await pick(page, "item-3", "70 g");
  await page.locator('.r-item[data-item="item-7"] .none-of').click(); // "none of these"
  await waitForPhase(page, "plan");

  const plan = await page.evaluate(() => window.__cartpilot.state.plan);
  expect(plan.unfulfilled).toEqual(["item-7"]);
  await expect(page.locator(".leftout")).toContainText("hing");
  const lines = plan.carts.flatMap((c) => c.lines);
  expect(lines.find((l) => l.item_id === "item-1").product_name).toContain("Amul Gold");
  expect(lines.find((l) => l.item_id === "item-2").size_text).toBe("12 pcs");
  const maggi = lines.find((l) => l.item_id === "item-3");
  expect([maggi.quantity, maggi.size_text]).toEqual([2, "70 g"]);

  await page.click('[data-action="fill"]');
  await waitForPhase(page, "done");
  const cart = await storeCart(page, plan.assignment["item-3"]);
  expect(cart.items.find((i) => i.product_id === maggi.product_id).quantity).toBe(2);
  await expect(page.locator('#sec-fill li[data-item="item-3"]')).toContainText("2× Maggi");
});

test("remembers a choice next time, and Change reopens it", async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await runList(page, "eggs, onion 1kg");
  await waitForPhase(page, "review");
  await pick(page, "item-1", "30 pcs");
  await waitForPhase(page, "plan");

  await runList(page, "eggs, onion 1kg");
  await waitForPhase(page, "plan"); // no question this time
  await expect(page.locator('.r-item[data-item="item-1"] .r-meta')).toContainText("remembered", { useInnerText: false });
  expect(await page.evaluate(() => window.__cartpilot.state.plan.carts.flatMap((c) => c.lines).find((l) => l.item_id === "item-1").size_text)).toBe("30 pcs");

  await page.locator("details.fold summary").click(); // confirmed products fold away once the plan is built
  await page.locator('.r-item[data-item="item-1"] [data-action="expand"]').click();
  await pick(page, "item-1", "6 pcs");
  await page.waitForFunction(() => window.__cartpilot.state.plan.carts.flatMap((c) => c.lines).some((l) => l.size_text === "6 pcs"));
});

test("plan controls: app limit, minimum saving and fee edits re-optimise", async ({ page }) => {
  await runList(page, WEEKEND);
  await waitForPhase(page, "plan");
  const split = await page.evaluate(() => window.__cartpilot.state.plan);

  await page.click('[data-action="max-apps"][data-value="1"]');
  await page.waitForFunction(() => window.__cartpilot.state.plan.carts.length === 1);
  const single = await page.evaluate(() => window.__cartpilot.state.plan);
  expect(single.total).toBe(split.best_single.total);
  await expect(page.locator(".hero h2")).toContainText("is the cheapest");

  await page.click('[data-action="max-apps"][data-value="0"]');
  await page.waitForFunction(() => window.__cartpilot.state.plan.carts.length > 1);
  await page.fill("#min-saving", "5000");
  await page.locator("#min-saving").blur();
  await page.waitForFunction(() => window.__cartpilot.state.plan.kept_single_app === true);
  await expect(page.locator(".hero-sub")).toContainText("below your");

  await page.fill("#min-saving", "0");
  await page.locator("#min-saving").blur();
  await page.waitForFunction(() => window.__cartpilot.state.plan.carts.length > 1);
  await page.locator("details.more", { hasText: "Fees used" }).locator("summary").click();
  await page.fill('[data-fee="zepto.delivery_fee"]', "900");
  await page.locator('[data-fee="zepto.delivery_fee"]').blur();
  await page.waitForFunction(() => window.__cartpilot.state.fees.zepto.delivery_fee === 900);
  await page.fill('[data-fee="zepto.free_delivery_threshold"]', "");
  await page.locator('[data-fee="zepto.free_delivery_threshold"]').blur();
  await page.waitForFunction(() => window.__cartpilot.state.fees.zepto.free_delivery_threshold === null);
  await page.waitForFunction(() => !window.__cartpilot.state.plan.carts.some((c) => c.app === "zepto"));
  await expect(page.locator('details[data-keep="fees"]')).toHaveAttribute("open", ""); // stays open while you edit
  await expect(page.locator('fieldset[data-store="zepto"] legend')).toContainText("edited by you");
});

test("edit amounts and remove items after pricing, without searching again", async ({ page }) => {
  let searches = 0;
  page.on("request", (r) => {
    if (/\/mock\/(zepto\/api\/v3\/search|blinkit\/api\/v1\/layout\/search|instamart\/api\/instamart\/search)/.test(r.url())) searches++;
  });
  await runList(page, "onion 1kg, potato 1kg, aashirvaad atta 5kg");
  await waitForPhase(page, "plan");
  const before = await page.evaluate(() => window.__cartpilot.state.plan);
  const searchesAfterRun = searches;
  expect(searchesAfterRun).toBe(9); // 3 items on 3 stores

  await page.locator('.tag.edit[data-item="item-1"] [data-action="qty"][data-delta="1"]').click();
  await page.locator('.tag.edit[data-item="item-1"] [data-action="qty"][data-delta="1"]').click();
  await page.waitForFunction(() => window.__cartpilot.state.plan.carts.flatMap((c) => c.lines).find((l) => l.item_id === "item-1").quantity === 3);
  const after = await page.evaluate(() => window.__cartpilot.state.plan);
  const onion = after.carts.flatMap((c) => c.lines).find((l) => l.item_id === "item-1");
  expect(onion.line_total).toBe(3 * onion.unit_price);
  expect(after.total).toBeGreaterThan(before.total);
  await expect(page.locator('.tag.edit[data-item="item-1"] b')).toHaveText("3");
  await expect(page.locator('.tag.edit[data-item="item-2"] [data-delta="-1"]')).toBeDisabled(); // cannot go below 1

  await page.locator('.tag.edit[data-item="item-2"] [data-action="remove-item"]').click();
  await page.waitForFunction(() => !("item-2" in window.__cartpilot.state.plan.assignment));
  await expect(page.locator(".tag.edit")).toHaveCount(2);
  expect(searches).toBe(searchesAfterRun); // no store was searched again

  await page.click('[data-action="fill"]');
  await waitForPhase(page, "done");
  const plan = await page.evaluate(() => window.__cartpilot.state.plan);
  let units = 0;
  for (const cart of plan.carts) units += (await storeCart(page, cart.app)).count;
  expect(units).toBe(4); // 3 onions + 1 atta, no potato
  await expect(page.locator(".tag.edit")).toHaveCount(0); // locked once filling starts
});

test("removing the last item goes back to the start", async ({ page }) => {
  await runList(page, "onion 1kg");
  await waitForPhase(page, "plan");
  await page.locator('[data-action="remove-item"]').click();
  await waitForPhase(page, "idle");
  await expect(page.locator("#sec-plan")).toBeHidden();
  await expect(page.locator("#intro")).toBeVisible();
});

test("saved lists persist, load and delete", async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('[data-action="save-list"]')).toHaveCount(0);
  await page.fill("#list-input", "ghee, paneer 200g, curd");
  await page.click('[data-action="save-list"]');
  await expect(page.locator(".chip.saved")).toHaveCount(1);
  await expect(page.locator(".chip.saved")).toContainText("ghee, paneer 200g +1");
  await expect(page.locator('[data-action="save-list"]')).toHaveCount(0); // already saved

  await page.reload();
  await page.fill("#list-input", "");
  await page.locator('.chip.saved [data-action="load-list"]').click();
  await expect(page.locator("#list-input")).toHaveValue("ghee, paneer 200g, curd");
  await page.locator('.chip.saved [data-action="delete-list"]').click();
  await expect(page.locator(".chip.saved")).toHaveCount(0);
  await page.evaluate(() => localStorage.clear());
});

test("theme button flips light and dark and is remembered", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => localStorage.removeItem("cartpilot.theme"));
  await page.reload();
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.click("#theme-toggle");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bg()).not.toBe(light);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.click("#theme-toggle");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bg()).toBe(light);
  await page.evaluate(() => localStorage.removeItem("cartpilot.theme"));
});

test("placeholders and a time estimate show while prices load", async ({ page }) => {
  await page.click('[data-action="set"][data-name="pace"][data-value="human"]');
  await runList(page, "onion 1kg, potato 1kg, tomato 1kg, ginger");
  await waitForPhase(page, "collecting");
  await expect(page.locator(".r-item.skeleton")).toHaveCount(4);
  await expect(page.locator("#working")).toContainText("Checking prices on 3 stores");
  await expect(page.locator("#working")).toContainText(/About \d+ s left/);
  await page.click("#stop");
  await waitForPhase(page, "idle", 20_000);
  await expect(page.locator(".r-item.skeleton")).toHaveCount(0);
  await page.click('[data-action="set"][data-name="pace"][data-value="fast"]');
});

test("stop during price collection adds nothing", async ({ page }) => {
  await page.click('[data-action="set"][data-name="pace"][data-value="human"]');
  await runList(page, WEEKEND);
  await waitForPhase(page, "collecting");
  await page.waitForFunction(() => Object.values(window.__cartpilot.state.activity).some((a) => a.state === "collecting"));
  await page.click("#stop");
  await waitForPhase(page, "idle", 20_000);
  await expect(page.locator(".toast")).toContainText("Stopped");
  for (const store of STORES) expect((await storeCart(page, store)).count).toBe(0);
  await page.click('[data-action="set"][data-name="pace"][data-value="fast"]');
});

test("human pace really waits 1.5 to 3 seconds between searches", async ({ page }) => {
  const stamps = [];
  page.on("request", (request) => {
    if (request.url().includes("/mock/zepto/api/v3/search")) stamps.push(Date.now());
  });
  await page.click('[data-action="set"][data-name="pace"][data-value="human"]');
  await runList(page, "onion 1kg, potato 1kg, tomato 1kg");
  await waitForPhase(page, "plan");
  expect(stamps.length).toBe(3);
  for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(1500);
  await page.click('[data-action="set"][data-name="pace"][data-value="fast"]');
});

test("an item that goes out of stock at add time is reported, not hidden", async ({ page }) => {
  await runList(page, "onion 1kg, potato 1kg, aashirvaad atta 5kg");
  await waitForPhase(page, "plan");
  const plan = await page.evaluate(() => window.__cartpilot.state.plan);
  const cart = plan.carts[0];
  const victim = cart.lines[0];
  await page.route(`**/mock/${cart.app}/api/cart`, async (route) => {
    const body = route.request().postDataJSON();
    if (route.request().method() === "POST" && body.product_id === victim.product_id) {
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "OUT_OF_STOCK", message: "Just sold out." } }) });
    }
    return route.continue();
  });
  await page.click('[data-action="fill"]');
  await waitForPhase(page, "done");
  const row = page.locator(`#sec-fill li[data-item="${victim.item_id}"]`);
  await expect(row).toHaveAttribute("data-status", "out_of_stock");
  await expect(row).toContainText("Out of stock");
  await expect(row).toContainText("Also on"); // points at the next-cheapest app
  await expect(page.locator("#fill-summary")).toContainText("1 needs attention");
  const real = await storeCart(page, cart.app);
  expect(real.items.some((i) => i.product_id === victim.product_id)).toBe(false);
  expect(real.items.length).toBe(cart.lines.length - 1);
});

test("a bot check on the store page stops the run and is never worked around", async ({ page }) => {
  await runList(page, "onion 1kg, potato 1kg");
  await waitForPhase(page, "plan");
  const app = await page.evaluate(() => window.__cartpilot.state.plan.carts[0].app);
  const frame = page.frameLocator(`iframe[data-store="${app}"]`);
  await frame.locator("body").evaluate((body) => {
    const box = document.createElement("div");
    box.id = "challenge-form";
    box.textContent = "Please verify you are human";
    body.appendChild(box);
  });
  await page.click('[data-action="fill"]');
  await waitForPhase(page, "done");
  await expect(page.locator(`.stores li[data-store="${app}"] .s-status`)).toContainText("human check");
  await expect(page.locator("#sec-fill li").first()).toHaveAttribute("data-status", "skipped");
  expect((await storeCart(page, app)).count).toBe(0);
});

test("errors are shown in plain words", async ({ page }) => {
  await page.click("#go");
  await expect(page.locator(".toast.error")).toContainText("Type a few groceries");
  await runList(page, "!!! 123");
  await expect(page.locator(".toast.error").last()).toContainText("Could not find any grocery items");
  await page.route("**/parse", (route) => route.abort());
  await runList(page, "milk");
  await expect(page.locator(".toast.error").last()).toContainText("Cannot reach the CartPilot backend");
  expect(await page.evaluate(() => window.__cartpilot.state.phase)).toBe("idle");
});

test("items that exist nowhere are left out and said so", async ({ page }) => {
  await runList(page, "dragonfruit, onion 1kg");
  await waitForPhase(page, "plan");
  await page.locator("details.fold summary").click();
  await expect(page.locator('.r-item[data-item="item-1"] .badge')).toHaveText("Not found on any app");
  await expect(page.locator(".leftout")).toContainText("dragonfruit");
  expect(await page.evaluate(() => window.__cartpilot.state.plan.unfulfilled)).toEqual(["item-1"]);
});

for (const width of [360, 768]) {
  test(`layout holds at ${width}px with no sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await runList(page, WEEKEND);
    await waitForPhase(page, "plan");
    await page.locator("details.more").first().locator("summary").click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
