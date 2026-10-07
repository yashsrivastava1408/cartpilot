/*
 * CartPilot driver: the engine that works a storefront the way a person would.
 *
 *   collect  type each item into the site's own search box, one at a time, and read
 *            the results the site loads for itself (via page-hook.js)
 *   fill     search each planned product again and click its real "Add" button,
 *            then confirm the cart actually changed
 *
 * Hard rules, enforced here and not configurable from outside:
 *   - on a live store the pause between items is always 1.5 to 3 seconds
 *   - if the site shows a CAPTCHA or bot check, the run stops and reports "blocked"
 *   - nothing here touches checkout or payment
 *
 * The driver is transport-agnostic: the extension content script and the web demo's
 * iframe bridge both create one and pass in `emit` (and optionally `sleep`).
 */
(() => {
  const CP = (globalThis.CartPilot = globalThis.CartPilot || {});

  const HUMAN = { minDelay: 1500, maxDelay: 3000, keyMin: 45, keyMax: 110, clickMin: 350, clickMax: 800 };
  const FAST = { minDelay: 140, maxDelay: 280, keyMin: 4, keyMax: 10, clickMin: 60, clickMax: 120 };
  const WAIT = { search: 9000, settle: 350, loose: 1200, card: 4000, cart: 6000, input: 5000, ui: 1500 };
  const MAX_RESULTS = 20;
  const CHALLENGE_SELECTOR =
    'iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[title*="captcha" i], #challenge-form, [id*="captcha" i][role="dialog"]';
  const CHALLENGE_TEXT = /verify (that )?you('| a)?re (a )?human|are you a robot|unusual traffic|complete the captcha/i;

  class StopRun extends Error {}
  class Blocked extends Error {}

  const rand = (min, max) => min + Math.random() * (max - min);
  const norm = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const safe = (fn, fallback = false) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  CP.PACE = { HUMAN, FAST };

  CP.createDriver = function createDriver({ adapter, emit, sleep, doc = document, win = window }) {
    const nap = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const buffer = []; // recent search/cart responses copied by the page hook
    const wakeups = new Set();
    let storeFees = null;
    let run = null;
    let bannerEl = null;

    const is = {
      search: (m) => safe(() => adapter.search.isResponse(m.url, m.method)),
      cart: (m) => safe(() => adapter.cart.isResponse(m.url, m.method)),
      config: (m) => Boolean(adapter.config) && safe(() => adapter.config.isResponse(m.url, m.method)),
    };

    win.addEventListener("message", (event) => {
      const m = event.data;
      if (event.source !== win || !m || m.source !== "cartpilot-hook" || m.kind !== "response") return;
      if (is.config(m)) {
        storeFees = safe(() => adapter.config.parseFees(m.body), null) || storeFees;
        return;
      }
      if (!is.search(m) && !is.cart(m)) return; // everything else the site loads is ignored
      m.seenAt = Date.now();
      buffer.push(m);
      if (buffer.length > 40) buffer.shift();
      wakeups.forEach((wake) => wake());
    });

    // ---------------------------------------------------------- plumbing

    const send = (evt, payload = {}) =>
      safe(() => emit({ source: "cartpilot-driver", store: adapter.store, adapter: adapter.id, runId: run && run.id, evt, ...payload }));

    const info = (extra = {}) => ({
      ok: true,
      store: adapter.store,
      adapter: adapter.id,
      label: adapter.label,
      mock: adapter.mock,
      busy: Boolean(run),
      version: CP.VERSION,
      ...extra,
    });

    /** Resolve with the first truthy check() result, re-checked on DOM changes and hook messages. */
    function until(check, timeout) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          observer.disconnect();
          wakeups.delete(tick);
          resolve(value);
        };
        const tick = () => {
          if (done) return;
          const value = safe(check, null);
          if (value) finish(value);
        };
        const observer = new MutationObserver(tick);
        observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        wakeups.add(tick);
        nap(timeout).then(() => finish(null));
        (async () => {
          while (!done) {
            tick();
            await nap(200);
          }
        })();
      });
    }

    function challengeVisible() {
      if (safe(() => doc.querySelector(CHALLENGE_SELECTOR), null)) return true;
      const text = `${doc.title} ${safe(() => (doc.body.innerText || "").slice(0, 1500), "")}`;
      return CHALLENGE_TEXT.test(text);
    }

    function checkpoint() {
      if (!run || run.stopped) throw new StopRun("stopped");
      if (challengeVisible()) throw new Blocked("The store is asking for a human check. CartPilot stopped and will not try to get past it.");
    }

    const paceFor = (requested) => (adapter.mock && requested === "fast" ? FAST : HUMAN);

    // ---------------------------------------------------------- DOM helpers

    const visible = (el) => Boolean(el) && el.getClientRects().length > 0;

    function findVisible(selectors) {
      for (const selector of [].concat(selectors || [])) {
        const hit = safe(() => [...doc.querySelectorAll(selector)].find(visible), null);
        if (hit) return hit;
      }
      return null;
    }

    const buttonsIn = (root) => [...root.querySelectorAll('button, [role="button"]')];
    const label = (el) => `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`.trim();

    function addButton(card) {
      const s = adapter.selectors.addButton;
      return s ? card.querySelector(s) : buttonsIn(card).find((b) => /^\s*add\s*$/i.test(b.textContent || "")) || null;
    }

    function incButton(card) {
      const s = adapter.selectors.incButton;
      if (s) return card.querySelector(s);
      return buttonsIn(card).find((b) => /^\s*\+\s*$/.test(b.textContent || "") || /increase|increment|plus/i.test(label(b))) || null;
    }

    function readQty(card) {
      if (!card) return 0;
      const s = adapter.selectors.qtyValue;
      if (s) return parseInt((card.querySelector(s) || {}).textContent, 10) || 0;
      if (addButton(card)) return 0;
      const plus = incButton(card);
      const digits = plus && plus.parentElement && (plus.parentElement.textContent || "").match(/\d{1,2}/);
      return digits ? parseInt(digits[0], 10) : 0;
    }

    function isSoldOut(card) {
      const s = adapter.selectors.soldOut;
      if (s) return Boolean(card.querySelector(s));
      return /out of stock|sold out|notify me|currently unavailable/i.test(card.textContent || "");
    }

    /** Without an exact selector: the smallest block that holds the product name and a button. */
    function cardByName(name) {
      const want = norm(name);
      if (!want) return null;
      for (const button of buttonsIn(doc)) {
        if (!/^\s*(add|\+)\s*$/i.test(button.textContent || "") && !/add|increase/i.test(label(button))) continue;
        for (let el = button.parentElement, depth = 0; el && depth < 7; el = el.parentElement, depth++) {
          const text = norm(el.textContent);
          if (text.includes(want)) {
            if (text.length <= want.length + 400) return el;
            break; // this ancestor already spans several products
          }
        }
      }
      return null;
    }

    const findCard = (line) => (adapter.cardFor ? adapter.cardFor(doc, line) : cardByName(line.name));

    function setValue(input, value) {
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      // Frameworks such as React ignore a plain `input.value = x`; the native setter plus an input event is what typing does.
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    async function typeInto(input, text, pace) {
      input.focus();
      setValue(input, "");
      if (doc.hidden) return setValue(input, text); // timers are throttled in background tabs
      let typed = "";
      for (const ch of text) {
        typed += ch;
        setValue(input, typed);
        await nap(rand(pace.keyMin, pace.keyMax));
      }
    }

    function submit(input) {
      if (adapter.submit === "none") return;
      for (const type of ["keydown", "keypress", "keyup"]) {
        input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
      if (adapter.submit === "form" && input.form) {
        if (input.form.requestSubmit) input.form.requestSubmit();
        else input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    }

    function highlight(card) {
      const previous = { outline: card.style.outline, offset: card.style.outlineOffset, transition: card.style.transition };
      card.style.transition = "outline-color .2s";
      card.style.outline = "3px solid #16a34a";
      card.style.outlineOffset = "2px";
      nap(1800).then(() => {
        card.style.outline = previous.outline;
        card.style.outlineOffset = previous.offset;
        card.style.transition = previous.transition;
      });
    }

    function banner(text) {
      if (!text) {
        if (bannerEl) bannerEl.remove();
        bannerEl = null;
        return;
      }
      if (!bannerEl) {
        bannerEl = doc.createElement("div");
        bannerEl.id = "cartpilot-banner";
        bannerEl.setAttribute("role", "status");
        bannerEl.style.cssText =
          "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#0f172a;color:#fff;" +
          "font:600 13px/1.3 system-ui,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.3);" +
          "pointer-events:none;max-width:90vw;text-align:center";
        doc.documentElement.appendChild(bannerEl);
      }
      bannerEl.textContent = text;
    }

    // ---------------------------------------------------------- search

    async function searchInput() {
      let input = findVisible(adapter.selectors.searchInput);
      if (!input && adapter.selectors.searchTrigger) {
        const trigger = findVisible(adapter.selectors.searchTrigger);
        if (trigger) {
          trigger.click();
          input = await until(() => findVisible(adapter.selectors.searchInput), WAIT.input);
        }
      }
      if (!input) throw new Error("Could not find the store's search box.");
      return input;
    }

    function mentions(m, query) {
      const want = norm(query);
      const url = norm(safe(() => decodeURIComponent(m.url.replace(/\+/g, " ")), m.url));
      return url.includes(want) || norm(m.requestBody).includes(want);
    }

    /** The site's response for this exact query, or failing that the latest one after we pressed Enter. */
    function searchHit(query, typedAt, submittedAt) {
      const hits = buffer.filter((m) => m.seenAt >= typedAt && is.search(m));
      const exact = hits.filter((m) => mentions(m, query));
      if (exact.length) return exact[exact.length - 1];
      const late = hits.filter((m) => m.seenAt >= submittedAt);
      return late.length && Date.now() - late[0].seenAt > WAIT.loose ? late[late.length - 1] : null;
    }

    async function search(query, pace) {
      checkpoint();
      const input = await searchInput();
      const typedAt = Date.now();
      await typeInto(input, query, pace);
      const submittedAt = Date.now();
      submit(input);
      const pick = () => searchHit(query, typedAt, submittedAt);
      const hit = await until(pick, WAIT.search);
      if (!hit) return null;
      await nap(WAIT.settle); // let a late duplicate land so we read the final one
      return pick() || hit;
    }

    // ---------------------------------------------------------- collect

    async function collect(msg, out) {
      const pace = paceFor(msg.pace);
      const items = msg.items || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const progress = (state, extra) => send("progress", { phase: "collect", itemId: item.id, index: i, total: items.length, state, ...extra });
        progress("searching");
        out.results[item.id] = [];
        try {
          const hit = await search(item.query, pace);
          if (!hit) {
            out.errors[item.id] = "The store did not return search results in time.";
            progress("timeout");
          } else {
            const products = adapter.search.normalize(hit.body) || [];
            out.results[item.id] = products.slice(0, MAX_RESULTS);
            progress("done", { count: out.results[item.id].length });
          }
        } catch (error) {
          if (error instanceof StopRun || error instanceof Blocked) throw error;
          out.errors[item.id] = error.message || "Search failed.";
          progress("error");
        }
        if (i < items.length - 1) {
          await nap(rand(pace.minDelay, pace.maxDelay));
          checkpoint();
        }
      }
    }

    // ---------------------------------------------------------- fill

    function cartResult(line, since) {
      const hits = buffer.filter((m) => m.seenAt >= since && m.method !== "GET" && is.cart(m));
      if (!hits.length) return null;
      const last = hits[hits.length - 1];
      const parsed = safe(() => adapter.cart.parse(last.body, last.status), null) || { ok: last.status < 400 };
      if (!parsed.ok) return { ok: false, code: parsed.code || null };
      return { ok: true, qty: parsed.quantities ? parsed.quantities[line.productId] || 0 : null, via: "network" };
    }

    async function fillLine(line, pace) {
      const hit = await search(line.query, pace);
      let card = await until(() => findCard(line), hit ? WAIT.card : WAIT.ui);
      if (!card) {
        return { status: "not_found", detail: hit ? "This product is no longer in the search results." : "The store did not return search results." };
      }
      card.scrollIntoView({ block: "center", behavior: doc.hidden ? "auto" : "smooth" });
      highlight(card);
      await nap(rand(pace.clickMin, pace.clickMax));
      if (isSoldOut(card)) return { status: "out_of_stock", detail: "Out of stock right now." };

      const target = line.quantity;
      let qty = readQty(card);
      if (qty >= target) return { status: "added", quantity: qty, verified: "ui", detail: "Already in your cart." };

      let verified = "ui";
      const short = (detail) =>
        qty > 0 ? { status: "partial", quantity: qty, verified, detail: `Only ${qty} of ${target} went in. ${detail}` } : { status: "failed", detail };

      for (let guard = 0; qty < target && guard < 25; guard++) {
        checkpoint();
        card = findCard(line) || card;
        const button = qty === 0 ? addButton(card) : incButton(card);
        if (!button) return short("Could not find the Add button.");
        if (button.disabled) return qty > 0 ? short("The store would not allow more.") : { status: "out_of_stock", detail: "Out of stock right now." };

        const before = qty;
        const clickedAt = Date.now();
        button.click();
        const outcome = await until(() => {
          const network = cartResult(line, clickedAt);
          if (network) return network;
          const now = readQty(findCard(line));
          return now > before ? { ok: true, qty: now, via: "ui" } : null;
        }, WAIT.cart);

        if (!outcome) return short("The store did not confirm the add.");
        if (!outcome.ok) {
          return outcome.code === "OUT_OF_STOCK" && qty === 0
            ? { status: "out_of_stock", detail: "Out of stock right now." }
            : short("The store rejected the add.");
        }
        let confirmed = outcome;
        if (outcome.via === "ui") {
          // The page can repaint before the hook's copy of the cart response arrives; give it a moment.
          confirmed = (await until(() => cartResult(line, clickedAt), 700)) || outcome;
          if (!confirmed.ok) confirmed = outcome;
        }
        if (confirmed.via === "network") verified = "network";
        // The page re-renders after the cart changes; wait for the stepper before the next click.
        const shown = await until(() => (readQty(findCard(line)) > before ? readQty(findCard(line)) : 0), WAIT.ui);
        qty = confirmed.qty != null ? confirmed.qty : shown || before;
        if (qty <= before) return short("The cart quantity did not change.");
        if (qty < target) await nap(rand(pace.clickMin, pace.clickMax));
      }
      return qty >= target ? { status: "added", quantity: qty, verified } : short("Stopped before reaching the full quantity.");
    }

    async function fill(msg, out) {
      const pace = paceFor(msg.pace);
      const lines = msg.lines || [];
      banner("CartPilot is adding items here. You review and pay yourself.");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        send("progress", { phase: "fill", itemId: line.itemId, index: i, total: lines.length, state: "adding" });
        let result;
        try {
          result = await fillLine(line, pace);
        } catch (error) {
          if (error instanceof StopRun || error instanceof Blocked) throw error;
          result = { status: "failed", detail: error.message || "Something went wrong on the page." };
        }
        const record = { itemId: line.itemId, productId: line.productId, name: line.name, wanted: line.quantity, ...result };
        out.lines.push(record);
        send("line", record);
        if (i < lines.length - 1) {
          await nap(rand(pace.minDelay, pace.maxDelay));
          checkpoint();
        }
      }
    }

    // ---------------------------------------------------------- command handling

    async function execute(doneEvt, work, out) {
      try {
        await work(out);
        send(doneEvt, { ...out, stopped: false, blocked: false });
      } catch (error) {
        if (error instanceof StopRun) send(doneEvt, { ...out, stopped: true, blocked: false });
        else if (error instanceof Blocked) send(doneEvt, { ...out, stopped: true, blocked: true, message: error.message });
        else send("error", { message: (error && error.message) || "Unexpected error in the store tab." });
      } finally {
        banner(null);
        run = null;
      }
    }

    function start(msg, doneEvt, work, out) {
      if (run) return info({ ok: false, error: "busy" });
      run = { id: msg.runId, stopped: false };
      execute(doneEvt, (o) => work(msg, o), out);
      return info();
    }

    function handle(msg) {
      switch (msg && msg.cmd) {
        case "ping":
          return info();
        case "collect": {
          const out = { results: {}, errors: {} };
          Object.defineProperties(out, {
            fees: { enumerable: true, get: () => storeFees || adapter.defaultFees },
            feesSource: { enumerable: true, get: () => (storeFees ? "store" : "default") },
          });
          return start(msg, "collected", collect, out);
        }
        case "fill":
          return start(msg, "filled", fill, { lines: [] });
        case "stop":
          if (run) run.stopped = true;
          return info();
        case "showCart": {
          const button = findVisible(adapter.selectors.cartButton);
          if (button) button.click();
          return info({ ok: Boolean(button) });
        }
        default:
          return info({ ok: false, error: "unknown command" });
      }
    }

    return { handle, info };
  };
})();
