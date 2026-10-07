// CartPilot UI. One codebase for the extension side panel and the web demo.
import { createApi } from "./api.js";
import { STORES, EmbedTransport, ExtensionTransport } from "./transport.js";

const IS_EXT = window.location.protocol === "chrome-extension:";
const STORE_BY_ID = Object.fromEntries(STORES.map((s) => [s.id, s]));
const QUIET_LIMIT_MS = 60_000; // a store tab that says nothing for this long is treated as gone

const SAMPLES = [
  { label: "Weekly basics", text: "1L amul milk, eggs, 2 maggi, aashirvaad atta 5kg, onion 1kg, britannia bread, catch hing" },
  {
    label: "Weekend cook-up",
    text: "12 eggs, amul butter 500g, britannia bread, aashirvaad atta 5kg, toor dal 1kg, onion 1kg, tomato 1kg, fortune sunflower oil 1L, tata tea gold 500g, surf excel 1kg",
  },
  {
    label: "Monthly stock-up",
    text:
      "aashirvaad atta 5kg, madhur sugar 1kg, fortune sunflower oil 1L, toor dal 1kg, india gate rice 1kg, tata tea gold 500g, " +
      "surf excel 1kg, vim bar, colgate 200g, dettol soap, harpic 500ml, amul ghee 500ml, everest turmeric, mdh garam masala, " +
      "parle-g biscuits, 3 lays, 2 kurkure, onion 1kg, potato 1kg, tomato 1kg",
  },
];

// ------------------------------------------------------------ small utilities

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const rupee = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 })}`;
const uid = () => Math.random().toString(36).slice(2, 10);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const saved = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`cartpilot.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`cartpilot.${key}`, JSON.stringify(value));
    } catch {
      /* storage can be blocked; the app still works without it */
    }
  },
};

const settings = {
  apiBase: saved.get("apiBase", "http://localhost:8000"),
  source: saved.get("source", "mock"), // extension only: mock | live
  pace: saved.get("pace", "fast"), // mock stores only: fast | human
  theme: saved.get("theme", "auto"),
};
const apiBase = () => (IS_EXT ? settings.apiBase.replace(/\/+$/, "") : window.location.origin);
const api = createApi(apiBase);
const usingMock = () => !IS_EXT || settings.source === "mock";

const transport = IS_EXT ? new ExtensionTransport(apiBase, () => settings.source) : new EmbedTransport($("live-frames"), apiBase());

// ------------------------------------------------------------ state

const S = {
  phase: "idle", // idle | parsing | collecting | matching | review | plan | filling | done
  stopping: false,
  health: null,
  items: [],
  parseInfo: null,
  stores: {}, // store -> { connected, mock, label, url }
  activity: {}, // store -> { state, index, total, itemId, message, count }
  candidates: {},
  fees: {},
  feeSource: {},
  matches: {}, // itemId -> ItemMatch
  matcher: null,
  choices: {}, // itemId -> { kind: "variant" | "skip", key, per_app, label, remembered }
  expanded: {},
  foldOpen: false, // the confirmed-products list, once the plan is built
  plan: null,
  planError: null,
  options: { maxApps: 0, minSaving: 0 },
  fill: {}, // itemId -> line record
  liveTab: "zepto",
  recording: {}, // store -> true while the setup recorder runs (extension, live stores)
};
const pending = new Map(); // store -> { runId, resolve, last }
const htmlCache = {};

function safeQuery(root, selector) {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function setHtml(id, html) {
  if (htmlCache[id] === html) return false;
  htmlCache[id] = html;
  const el = $(id);
  // Sections the user opened by hand (price table, fees) stay open across re-renders.
  const kept = [...el.querySelectorAll("details[data-keep]")].filter((d) => d.open).map((d) => d.dataset.keep);
  // A field being typed in keeps its text and focus if the section redraws under it.
  const active = document.activeElement;
  const editing = active && el.contains(active) && active.tagName === "INPUT" ? { key: active.dataset.fee ? `[data-fee="${active.dataset.fee}"]` : `#${active.id}`, value: active.value } : null;
  el.innerHTML = html;
  if (editing) {
    const again = safeQuery(el, editing.key);
    if (again) {
      again.value = editing.value;
      again.focus();
    }
  }
  for (const key of kept) {
    const again = el.querySelector(`details[data-keep="${key}"]`);
    if (again) again.open = true;
  }
  return true;
}

/** Product picture: a real image URL on live stores, an emoji on the mock stores. */
function thumb(product) {
  const image = product && product.image;
  if (!image) return `<span class="thumb empty" aria-hidden="true"></span>`;
  return /^https?:/.test(image)
    ? `<img class="thumb" src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="thumb" aria-hidden="true">${esc(image)}</span>`;
}

/** Roll numbers marked with data-count from their previous value to the new one. */
const lastCount = {};
function animateCounts(root) {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const el of root.querySelectorAll("[data-count]")) {
    const key = el.dataset.countKey;
    const to = Number(el.dataset.count);
    const from = lastCount[key] ?? 0;
    lastCount[key] = to;
    if (still || from === to) {
      el.textContent = rupee(to);
      continue;
    }
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / 600);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = rupee(Math.round(from + (to - from) * eased));
      if (t < 1 && el.isConnected) requestAnimationFrame(step);
      else if (el.isConnected) el.textContent = rupee(to);
    };
    requestAnimationFrame(step);
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 4200);
}

const busy = () => ["parsing", "collecting", "matching", "filling"].includes(S.phase);
const itemById = (id) => S.items.find((i) => i.id === id);
const itemTitle = (item) => `${item.quantity > 1 ? `${item.quantity} × ` : ""}${item.brand && !item.name.toLowerCase().includes(item.brand.toLowerCase()) ? `${item.brand} ` : ""}${item.name}`;
const sizeLabel = (size) => {
  if (!size) return "";
  if (size.unit === "g" && size.value >= 1000) return `${+(size.value / 1000).toFixed(2)} kg`;
  if (size.unit === "ml" && size.value >= 1000) return `${+(size.value / 1000).toFixed(2)} L`;
  return `${+size.value.toFixed(2)} ${size.unit}`;
};

// ------------------------------------------------------------ matching decisions

const memoryKey = (item) => `${item.brand || ""}|${item.name}|${sizeLabel(item.size)}`.toLowerCase();

function optionsFor(match) {
  return match.status === "out_of_stock" ? match.substitutes : match.variants;
}

function hasStock(variant) {
  return Object.values(variant.per_app).some((p) => p.in_stock);
}

/** What the optimiser may buy for this item: { app: product }. Empty means "leave it out". */
function offersFor(item) {
  const match = S.matches[item.id];
  const choice = S.choices[item.id];
  if (!match || (choice && choice.kind === "skip")) return {};
  if (choice && choice.kind === "variant") {
    return Object.fromEntries(Object.entries(choice.per_app).filter(([, p]) => p.in_stock));
  }
  if (match.status !== "matched") return {};
  return Object.fromEntries(
    Object.entries(match.per_app)
      .filter(([, m]) => m.status === "matched" && m.product)
      .map(([app, m]) => [app, m.product]),
  );
}

function needsPick(item) {
  const match = S.matches[item.id];
  return Boolean(match && match.needs_user && !S.choices[item.id] && optionsFor(match).length);
}

const unresolvedCount = () => S.items.filter(needsPick).length;

function applyMemory() {
  const memory = saved.get("memory", {});
  for (const item of S.items) {
    const match = S.matches[item.id];
    const key = memory[memoryKey(item)];
    if (!match || !match.needs_user || !key) continue;
    const variant = optionsFor(match).find((v) => v.key === key && hasStock(v));
    if (variant) S.choices[item.id] = { kind: "variant", key: variant.key, per_app: variant.per_app, label: variant.label, remembered: true };
  }
}

// ------------------------------------------------------------ rendering

function renderSteps() {
  const index = { idle: S.items.length ? 0 : 0, parsing: 0, collecting: 1, matching: 1, review: 2, plan: 3, filling: 4, done: 4 }[S.phase];
  const names = ["List", "Prices", "Confirm", "Plan", "Fill carts"];
  setHtml(
    "steps",
    `<ol>${names
      .map((name, i) => {
        const state = S.phase === "done" || i < index ? "done" : i === index && S.phase !== "idle" ? "current" : "";
        return `<li class="${state}"${state === "current" ? ' aria-current="step"' : ""}><span>${state === "done" ? "✓" : i + 1}</span>${name}</li>`;
      })
      .join("")}</ol>`,
  );
}

const darkNow = () =>
  settings.theme === "dark" || (settings.theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);

function renderHeader() {
  const dark = darkNow();
  $("theme-toggle").setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  $("theme-toggle").title = dark ? "Light theme" : "Dark theme";
  $("theme-toggle").dataset.dark = String(dark);
  $("mode-pill").textContent = usingMock() ? "Demo · mock stores" : "Live stores";
  $("mode-pill").className = `pill ${usingMock() ? "demo" : "live-mode"}`;
  const h = S.health;
  const el = $("backend-status");
  el.className = `status ${h === null ? "wait" : h ? "ok" : "down"}`;
  el.lastElementChild.textContent = h === null ? "Checking…" : h ? `Backend ready · ${{ jev: "Jev", groq: "Groq" }[h.matcher] || "offline"} matching` : "Backend offline";
  el.title = h ? `Parser: ${h.parse_provider} · Matcher: ${h.matcher} · Embeddings: ${h.embedder} · ILP: ${h.ilp_available ? "yes" : "no"}` : "";

  const seg = (name, value, options) =>
    `<div class="seg" role="group">${options
      .map(([v, label]) => `<button data-action="set" data-name="${name}" data-value="${v}" class="${value === v ? "on" : ""}" aria-pressed="${value === v}">${label}</button>`)
      .join("")}</div>`;
  setHtml(
    "settings-body",
    `
    ${IS_EXT ? `<label class="field"><span>Store pages</span>${seg("source", settings.source, [["mock", "Mock"], ["live", "Live"]])}</label>
    <label class="field"><span>Backend URL</span><input type="url" id="api-base" value="${esc(settings.apiBase)}" spellcheck="false"></label>` : ""}
    <label class="field"><span>Theme</span>${seg("theme", settings.theme, [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]])}</label>
    <button class="btn small ghost" data-action="forget">Forget my remembered choices</button>
    <p class="fine">Version 1.0.0</p>`,
  );
}

function renderList() {
  $("go").hidden = busy();
  $("stop").hidden = !busy();
  $("stop").disabled = S.stopping;
  $("stop").textContent = S.stopping ? "Stopping…" : "Stop";
  $("go").textContent = S.items.length ? "Run again" : "Find the best split";
  $("list-input").disabled = busy();
  $("list-count").hidden = S.items.length > 0; // the parsed count below is the accurate one
  const lists = saved.get("lists", []);
  const text = $("list-input").value.trim();
  const canSave = text && !busy() && !lists.some((l) => l.text === text) && !SAMPLES.some((x) => x.text === text);
  setHtml(
    "samples",
    `<span>Try:</span>${SAMPLES.map((x, i) => `<button class="chip" data-action="sample" data-index="${i}" ${busy() ? "disabled" : ""}>${esc(x.label)}</button>`).join("")}
    ${lists.length ? `<span class="sep">Saved:</span>` : ""}${lists
      .map(
        (l, i) =>
          `<span class="chip saved"><button data-action="load-list" data-index="${i}" ${busy() ? "disabled" : ""} title="${esc(l.text)}">${esc(l.name)}</button><button class="x" data-action="delete-list" data-index="${i}" aria-label="Delete saved list ${esc(l.name)}">✕</button></span>`,
      )
      .join("")}
    ${canSave ? `<button class="link" data-action="save-list">Save this list</button>` : ""}`,
  );
  const working = {
    parsing: "Reading your list…",
    collecting: `Checking prices on ${plural(Object.values(S.stores).filter((x) => x.connected).length, "store")}, one item at a time…${timeLeft()}`,
    matching: `Matching products${S.health && S.health.matcher !== "fuzzy" ? ` with ${{ jev: "Jev", groq: "Groq" }[S.health.matcher]}` : ""}…`,
    filling: "Adding items to your carts…",
  }[S.phase];
  setHtml("working", working ? `<span class="spinner" aria-hidden="true"></span>${esc(working)}` : "");
  $("working").hidden = !working;
  $("intro").hidden = S.phase !== "idle" || S.items.length > 0;
  if (!S.items.length) return setHtml("items", "");
  const note = S.parseInfo && S.parseInfo.warnings.length ? `<p class="warn-line">${esc(S.parseInfo.warnings.join(" "))}</p>` : "";
  const editable = canEdit();
  setHtml(
    "items",
    `<div class="parsed"><span class="parsed-label">Understood as ${plural(S.items.length, "item")}${editable ? " · change amounts or remove here" : ""}</span>
      ${S.items
        .map((i) => {
          const name = `${esc(i.brand && !i.name.toLowerCase().includes(i.brand.toLowerCase()) ? `${i.brand} ` : "")}${esc(i.name)}`;
          const size = i.size ? `<em>${esc(sizeLabel(i.size))}</em>` : "";
          if (!editable) return `<span class="tag">${i.quantity > 1 ? `<b>${i.quantity}×</b>` : ""}${name}${size}</span>`;
          return `<span class="tag edit" data-item="${i.id}">
            <button class="mini" data-action="qty" data-item="${i.id}" data-delta="-1" ${i.quantity <= 1 ? "disabled" : ""} aria-label="One less ${esc(i.name)}">−</button>
            <b aria-label="Quantity">${i.quantity}</b>
            <button class="mini" data-action="qty" data-item="${i.id}" data-delta="1" ${i.quantity >= 50 ? "disabled" : ""} aria-label="One more ${esc(i.name)}">+</button>
            <span class="t-name">${name}${size}</span>
            <button class="mini x" data-action="remove-item" data-item="${i.id}" aria-label="Remove ${esc(i.name)}">✕</button></span>`;
        })
        .join("")}
    </div>${note}`,
  );
}

/** Items can be edited once prices are in, until cart filling starts. */
function canEdit() {
  return ["review", "plan"].includes(S.phase) || (S.phase === "idle" && S.items.length > 0 && Object.keys(S.matches).length > 0);
}

function timeLeft() {
  const remaining = Math.max(0, ...Object.values(S.activity).filter((a) => a.state === "collecting").map((a) => a.total - a.index - 1));
  const perItem = usingMock() && settings.pace === "fast" ? 0.7 : 3.2;
  const seconds = Math.round((remaining * perItem) / 5) * 5;
  return seconds >= 5 ? ` About ${seconds} s left.` : "";
}

function storeStatus(id) {
  const info = S.stores[id] || {};
  const a = S.activity[id] || {};
  const item = a.itemId && itemById(a.itemId);
  if (!info.connected) return { text: IS_EXT ? "Not open in a tab" : "Loading the mock store…", tone: "off", pct: 0 };
  switch (a.state) {
    case "collecting":
      return { text: `Searching ${a.index + 1} of ${a.total}${item ? ` · ${item.name}` : ""}`, tone: "busy", pct: (100 * (a.index + 0.5)) / a.total };
    case "collected":
      return { text: a.message || `Prices read for ${plural(a.count, "item")}`, tone: a.tone || "ok", pct: 100 };
    case "filling":
      return { text: `Adding ${a.index + 1} of ${a.total}${item ? ` · ${item.name}` : ""}`, tone: "busy", pct: (100 * (a.index + 0.5)) / a.total };
    case "filled":
      return { text: a.message || "Cart filled", tone: a.tone || "ok", pct: 100 };
    case "blocked":
      return { text: "Stopped: the store asked for a human check", tone: "bad", pct: 100 };
    case "error":
      return { text: a.message || "Something went wrong in this tab", tone: "bad", pct: 100 };
    case "stopped":
      return { text: "Stopped", tone: "off", pct: 0 };
    default:
      return { text: "Ready", tone: "ok", pct: 0 };
  }
}

function renderStores() {
  const paceControl = usingMock()
    ? `<div class="seg" role="group" aria-label="Speed">
        <button data-action="set" data-name="pace" data-value="fast" class="${settings.pace === "fast" ? "on" : ""}" ${busy() ? "disabled" : ""}>Demo speed</button>
        <button data-action="set" data-name="pace" data-value="human" class="${settings.pace === "human" ? "on" : ""}" ${busy() ? "disabled" : ""}>Human pace</button>
      </div>`
    : `<span class="hint">Human pace: 1.5–3 s between items</span>`;
  setHtml(
    "sec-stores",
    `<div class="card-head"><h2 id="h-stores">Stores</h2>${paceControl}</div>
    <ul class="stores">${STORES.map((s) => {
      const st = storeStatus(s.id);
      const info = S.stores[s.id] || {};
      return `<li data-store="${s.id}" class="tone-${st.tone}">
        <span class="dot" aria-hidden="true"></span>
        <div class="s-main"><strong>${esc(s.label)}${info.connected && !info.mock ? "" : usingMock() ? ' <small>mock</small>' : ""}</strong>
          <span class="s-status">${esc(st.text)}</span>
          <div class="bar" aria-hidden="true"><i style="width:${Math.round(st.pct)}%"></i></div></div>
        ${IS_EXT && !info.connected ? `<button class="btn small" data-action="open-store" data-store="${s.id}">Open</button>` : ""}
        ${
          IS_EXT && !usingMock() && info.connected && !busy()
            ? S.recording[s.id]
              ? `<button class="btn small rec on" data-action="record-stop" data-store="${s.id}">Save recording</button>`
              : `<button class="btn small rec" data-action="record-start" data-store="${s.id}" title="Record this store's setup">Record setup</button>`
            : ""
        }
      </li>`;
    }).join("")}</ul>
    ${
      IS_EXT && !usingMock()
        ? `${
            Object.values(S.recording).some(Boolean)
              ? `<ol class="rec-steps"><li>Go to the store tab.</li><li>Search for <b>milk</b> and wait for results.</li><li>Click <b>Add</b> on one product.</li><li>Come back here and press <b>Save recording</b>.</li></ol>`
              : ""
          }<p class="fine">Live adapters are scaffolds: open each store, log in yourself, and fill the TODO(devtools) values in <code>extension/src/adapters.js</code> first. Fees below are placeholders until you correct them.</p>`
        : ""
    }`,
  );
}

function pricePills(perApp) {
  return STORES.map((s) => {
    const p = perApp[s.id];
    if (!p) return `<span class="pp none" data-store="${s.id}" title="Not listed on ${s.label}"><i></i>—</span>`;
    return `<span class="pp${p.in_stock ? "" : " out"}" data-store="${s.id}" title="${esc(s.label)}${p.in_stock ? "" : " · out of stock"}"><i></i>${p.in_stock ? rupee(p.price) : "out"}</span>`;
  }).join("");
}

function renderReviewItem(item) {
  const match = S.matches[item.id];
  const choice = S.choices[item.id];
  const title = `<div class="r-title"><strong>${esc(itemTitle(item))}</strong>${item.size ? `<span class="tag mini">${esc(sizeLabel(item.size))}</span>` : ""}</div>`;
  if (!match) return "";
  const options = optionsFor(match);
  const open = needsPick(item) || S.expanded[item.id];
  const locked = S.phase === "filling";

  let summary;
  if (choice && choice.kind === "skip") {
    summary = `<span class="badge off">Skipped</span><button class="link" data-action="unpick" data-item="${item.id}" ${locked ? "disabled" : ""}>Undo</button>`;
  } else if (needsPick(item)) {
    summary = `<span class="badge ask">${match.status === "out_of_stock" ? "Out of stock · substitute?" : "Which one?"}</span>`;
  } else if (match.status === "not_found") {
    summary = `<span class="badge off">Not found on any app</span>`;
  } else if (match.status === "out_of_stock" && !choice) {
    summary = `<span class="badge off">Out of stock everywhere</span>`;
  } else {
    const offers = Object.values(offersFor(item));
    const prices = offers.map((p) => p.price);
    const label = choice ? choice.label : (offers[0] && offers.reduce((a, b) => (a.name.length <= b.name.length ? a : b)).name) || "";
    const range = prices.length ? (Math.min(...prices) === Math.max(...prices) ? rupee(prices[0]) : `${rupee(Math.min(...prices))}–${rupee(Math.max(...prices))}`) : "";
    const why = Object.values(match.per_app).map((m) => m.reason).find((r) => r && !/clear best match|several similar/.test(r));
    summary = `${thumb(offers[0])}<span class="picked"${why && !choice ? ` title="${esc(why)}"` : ""}>${esc(label)}${offers[0] && offers[0].size_text ? ` · ${esc(offers[0].size_text)}` : ""}</span>
      <span class="r-meta">${range} on ${plural(offers.length, "app")}${choice && choice.remembered ? " · remembered" : ""}</span>
      ${options.length ? `<button class="link" data-action="expand" data-item="${item.id}" ${locked ? "disabled" : ""}>${open ? "Close" : "Change"}</button>` : ""}`;
  }

  const optionList =
    open && options.length
      ? `<div class="options" role="group" aria-label="Options for ${esc(item.name)}">
          ${options
            .map((v) => {
              const stock = hasStock(v);
              const on = choice && choice.key === v.key;
              return `<button class="option${on ? " on" : ""}" data-action="pick" data-item="${item.id}" data-key="${esc(v.key)}" ${stock && !locked ? "" : "disabled"} aria-pressed="${Boolean(on)}">
                <span class="o-name">${thumb(Object.values(v.per_app)[0])}${esc(v.label)}${v.size_text ? ` <small>${esc(v.size_text)}</small>` : ""}
                  ${v.kind === "substitute" ? `<span class="badge sub">Substitute${v.different_brand ? " · different brand" : ""}</span>` : ""}
                  ${stock ? "" : `<span class="badge off">Out of stock</span>`}</span>
                <span class="o-prices">${pricePills(v.per_app)}</span>
              </button>`;
            })
            .join("")}
          <button class="option none-of" data-action="skip" data-item="${item.id}" ${locked ? "disabled" : ""}>None of these · skip this item</button>
        </div>`
      : "";
  return `<li class="r-item${needsPick(item) ? " ask" : ""}" data-item="${item.id}">${title}<div class="r-summary">${summary}</div>${optionList}</li>`;
}

function renderReview() {
  const loading = ["collecting", "matching"].includes(S.phase) && S.items.length > 0;
  const show = Object.keys(S.matches).length > 0 || loading;
  $("sec-review").hidden = !show;
  if (!show) return setHtml("sec-review", "");
  if (loading) {
    return setHtml(
      "sec-review",
      `<div class="card-head"><h2>Confirm the products</h2><span class="hint">${S.phase === "matching" ? "Matching…" : "Waiting for prices…"}</span></div>
      <ul class="review" aria-busy="true">${S.items
        .map((i) => `<li class="r-item skeleton"><div class="r-title"><strong>${esc(itemTitle(i))}</strong></div><div class="sk-line"></div></li>`)
        .join("")}</ul>`,
    );
  }
  const open = unresolvedCount();
  setHtml(
    "sec-review",
    `<div class="card-head"><h2>Confirm the products</h2>
      <span class="hint">${open ? `${plural(open, "item")} need${open === 1 ? "s" : ""} your pick` : "All set"}</span></div>
    <details class="fold" ${open || S.phase === "review" || S.foldOpen ? "open" : ""}><summary>${plural(S.items.length, "item")} checked</summary>
    <ul class="review">${S.items.map(renderReviewItem).join("")}</ul></details>
    ${open ? `<div class="actions"><button class="btn ghost" data-action="skip-rest">Skip the rest and continue</button></div>` : ""}`,
  );
}

function renderPlan() {
  const plan = S.plan;
  const show = Boolean(plan || S.planError) && ["plan", "filling", "done"].includes(S.phase);
  $("sec-plan").hidden = !show;
  if (!show) return setHtml("sec-plan", "");
  if (S.planError) return setHtml("sec-plan", `<section class="card"><p class="warn-line">${esc(S.planError)}</p></section>`);

  const locked = S.phase !== "plan";
  const single = plan.best_single;
  const splitApps = plan.carts.length;
  let headline;
  let sub;
  if (!plan.carts.length) {
    headline = "Nothing to buy";
    sub = plan.notes[0] || "No item is available.";
  } else if (single && plan.savings > 0) {
    headline = `You save ${rupee(plan.savings)}`;
    sub = `${plan.savings_pct}% less than buying everything on ${STORE_BY_ID[single.app].label} (${rupee(single.total)}).`;
  } else if (single) {
    headline = splitApps === 1 ? `${STORE_BY_ID[plan.carts[0].app].label} is the cheapest` : "No extra saving from splitting";
    sub = plan.kept_single_app ? plan.notes[0] : "One app already gives the lowest total, fees included.";
  } else {
    headline = "Best available split";
    sub = "No single app has every item, so there is no one-app price to compare with.";
  }

  const rows = [
    ...plan.baselines.map((b) => ({ label: `All on ${STORE_BY_ID[b.app].label}`, total: b.total, store: b.app, note: b.complete ? "" : `missing ${plural(b.missing.length, "item")}`, faded: !b.complete })),
    { label: splitApps > 1 ? `CartPilot split (${splitApps} apps)` : "CartPilot plan", total: plan.total, best: true },
  ];
  const max = Math.max(...rows.map((r) => r.total), 1);
  const bars = rows
    .map(
      (r) => `<div class="cmp${r.best ? " best" : ""}${r.faded ? " faded" : ""}" ${r.store ? `data-store="${r.store}"` : ""}>
        <span class="c-label">${esc(r.label)}${r.note ? ` <small>${esc(r.note)}</small>` : ""}</span>
        <span class="c-bar"><i style="width:${Math.max(4, Math.round((100 * r.total) / max))}%"></i></span>
        <span class="c-total">${rupee(r.total)}</span></div>`,
    )
    .join("");

  const byProduct = {};
  for (const item of S.items) for (const p of Object.values(offersFor(item))) byProduct[p.id] = p;

  // Where the saving comes from: items that cost less in the plan than on the best single app.
  const wins = [];
  if (single && plan.savings > 0) {
    for (const c of plan.carts) {
      for (const l of c.lines) {
        const item = itemById(l.item_id);
        const there = item && offersFor(item)[single.app];
        if (there && c.app !== single.app) {
          const diff = Math.round((there.price * l.quantity - l.line_total) * 100) / 100;
          if (diff > 0) wins.push({ name: l.product_name, diff, app: c.app });
        }
      }
    }
    wins.sort((a, b) => b.diff - a.diff);
  }
  const winsHtml = wins.length
    ? `<div class="wins"><h3>Where the saving comes from</h3><ul>${wins
        .slice(0, 4)
        .map((w) => `<li data-store="${w.app}"><i class="dot"></i><span>${esc(w.name)}</span><b>${rupee(w.diff)} less on ${esc(STORE_BY_ID[w.app].label)}</b></li>`)
        .join("")}</ul>${wins.length > 4 ? `<p class="fine">and ${plural(wins.length - 4, "more item")}. Fees are counted in the totals above.</p>` : ""}</div>`
    : "";
  const shareBar = plan.carts.length > 1
    ? `<div class="share" role="img" aria-label="Share of the total per app">${plan.carts
        .map((c) => `<span data-store="${c.app}" style="flex:${Math.max(c.total, 1)}" title="${esc(STORE_BY_ID[c.app].label)} ${rupee(c.total)}"></span>`)
        .join("")}</div><div class="share-legend">${plan.carts
        .map((c) => `<span data-store="${c.app}"><i class="dot"></i>${esc(STORE_BY_ID[c.app].label)} ${rupee(c.total)}</span>`)
        .join("")}</div>`
    : "";

  const carts = plan.carts
    .map(
      (c) => `<article class="cart" data-store="${c.app}">
      <header><span class="dot"></span><h3>${esc(STORE_BY_ID[c.app].label)}</h3><span class="cart-count">${plural(c.lines.length, "item")}</span><strong>${rupee(c.total)}</strong></header>
      <ul>${c.lines
        .map((l) => `<li>${thumb(byProduct[l.product_id])}<span class="q">${l.quantity}×</span><span class="n">${esc(l.product_name)}${l.size_text ? ` <small>${esc(l.size_text)}</small>` : ""}</span><span class="p">${rupee(l.line_total)}</span></li>`)
        .join("")}</ul>
      <dl>
        <div><dt>Items</dt><dd>${rupee(c.subtotal)}</dd></div>
        <div><dt>Delivery</dt><dd>${c.delivery_fee ? rupee(c.delivery_fee) : '<span class="free">Free</span>'}</dd></div>
        ${c.handling_fee ? `<div><dt>Handling</dt><dd>${rupee(c.handling_fee)}</dd></div>` : ""}
        ${c.small_cart_fee ? `<div><dt>Small cart fee</dt><dd>${rupee(c.small_cart_fee)}</dd></div>` : ""}
      </dl>
      ${c.free_delivery_gap ? `<p class="gap">${rupee(c.free_delivery_gap)} short of free delivery. Moving more here would have cost more overall.</p>` : ""}
    </article>`,
    )
    .join("");

  const left = plan.unfulfilled.map((id) => itemById(id)).filter(Boolean);
  const apps = Object.keys(S.fees);
  const table = `<details class="more" data-keep="prices"><summary>Compare every price</summary><div class="scroll"><table class="prices">
    <thead><tr><th>Item</th>${apps.map((a) => `<th data-store="${a}"><i class="dot"></i>${esc(STORE_BY_ID[a].label)}</th>`).join("")}</tr></thead>
    <tbody>${S.items
      .map((item) => {
        const offers = offersFor(item);
        const costs = Object.values(offers).map((p) => p.price);
        const low = costs.length ? Math.min(...costs) : null;
        return `<tr><th>${esc(itemTitle(item))}</th>${apps
          .map((a) => {
            const p = offers[a];
            if (!p) return `<td class="na">—</td>`;
            const chosen = plan.assignment[item.id] === a;
            return `<td class="${chosen ? "chosen" : ""}${p.price === low ? " low" : ""}">${rupee(p.price * item.quantity)}${chosen ? '<span class="tick" title="In your plan">✓</span>' : ""}</td>`;
          })
          .join("")}</tr>`;
      })
      .join("")}</tbody></table></div><p class="fine">✓ marks where CartPilot buys the item. The cheapest price is bold; it is not always chosen, because fees matter too.</p></details>`;

  const feeField = (app, key, label) => {
    const value = S.fees[app][key];
    return `<label><span>${label}</span><input type="number" min="0" step="1" inputmode="decimal" data-fee="${app}.${key}" value="${value ?? ""}" ${key === "free_delivery_threshold" ? 'placeholder="never"' : ""} ${locked ? "disabled" : ""}></label>`;
  };
  const fees = `<details class="more" data-keep="fees"><summary>Fees used in this plan</summary>
    ${apps
      .map(
        (a) => `<fieldset class="fees" data-store="${a}"><legend><i class="dot"></i>${esc(STORE_BY_ID[a].label)} <small>${S.feeSource[a] === "store" ? "read from the store page" : S.feeSource[a] === "edited" ? "edited by you" : "placeholder, please check"}</small></legend>
        ${feeField(a, "delivery_fee", "Delivery fee")}${feeField(a, "free_delivery_threshold", "Free delivery from")}${feeField(a, "handling_fee", "Handling fee")}${feeField(a, "small_cart_fee", "Small cart fee")}${feeField(a, "small_cart_threshold", "Small cart below")}
      </fieldset>`,
      )
      .join("")}</details>`;

  const saving = single && plan.savings > 0;
  const changed = setHtml(
    "sec-plan",
    `<section class="hero${saving ? " win" : ""}" aria-live="polite">
      <div class="hero-top">
        <div class="hero-main"><p class="eyebrow">Your cheapest plan</p>
          <h2 aria-label="${esc(headline)}">${saving ? `You save <span data-count="${plan.savings}" data-count-key="savings">${rupee(plan.savings)}</span>` : esc(headline)}</h2>
          <p class="hero-sub">${esc(sub)}</p></div>
        <div class="hero-total"><span>Total to pay</span><strong data-count="${plan.total}" data-count-key="total">${rupee(plan.total)}</strong><small>${splitApps ? `across ${plural(splitApps, "app")}, fees included` : ""}</small></div>
      </div>
      ${shareBar}
      ${plan.carts.length ? `<div class="hero-foot"><button class="hero-copy" data-action="copy-plan">Copy plan as text</button></div>` : ""}
    </section>
    <section class="card">
      <div class="card-head"><h2>How it compares</h2><span class="hint">${plan.method === "ilp" ? "Solved exactly with an ILP" : "Every split checked"}</span></div>
      <div class="cmps">${bars}</div>
      ${winsHtml}
      <div class="knobs">
        <div class="knob"><span>Use at most</span><div class="seg" role="group">
          ${[[0, "Any"], [1, "1 app"], [2, "2 apps"]].map(([v, l]) => `<button data-action="max-apps" data-value="${v}" class="${S.options.maxApps === v ? "on" : ""}" ${locked ? "disabled" : ""}>${l}</button>`).join("")}</div></div>
        <label class="knob"><span>Only split if it saves at least</span><span class="money"><i>₹</i><input type="number" id="min-saving" min="0" step="5" value="${S.options.minSaving}" ${locked ? "disabled" : ""}></span></label>
      </div>
    </section>
    <div class="carts">${carts}</div>
    ${left.length ? `<section class="card"><div class="card-head"><h2>Left out</h2><span class="hint">Not available on any app</span></div><p class="leftout">${left.map((i) => `<span class="tag">${esc(itemTitle(i))}</span>`).join("")}</p></section>` : ""}
    <section class="card">${table}${fees}</section>
    ${
      plan.carts.length && S.phase === "plan"
        ? `<section class="cta"><div><strong>Ready to fill ${plural(splitApps, "cart")}?</strong><p>CartPilot searches each product and clicks Add. You review every cart and pay in the app yourself.</p></div>
            <button class="btn primary big" data-action="fill">Fill my ${splitApps === 1 ? "cart" : "carts"}</button></section>`
        : ""
    }`,
  );
  if (changed) animateCounts($("sec-plan"));
}

function planAsText() {
  const plan = S.plan;
  const head = [`CartPilot plan: ${rupee(plan.total)} total`];
  if (plan.best_single && plan.savings > 0) head.push(`Saves ${rupee(plan.savings)} vs all on ${STORE_BY_ID[plan.best_single.app].label} (${rupee(plan.best_single.total)})`);
  const body = plan.carts.map((c) =>
    [
      "",
      `${STORE_BY_ID[c.app].label}: ${rupee(c.total)}`,
      ...c.lines.map((l) => `  ${l.quantity} x ${l.product_name}${l.size_text ? ` (${l.size_text})` : ""}  ${rupee(l.line_total)}`),
      `  Delivery ${c.delivery_fee ? rupee(c.delivery_fee) : "free"}${c.handling_fee ? `, handling ${rupee(c.handling_fee)}` : ""}${c.small_cart_fee ? `, small cart fee ${rupee(c.small_cart_fee)}` : ""}`,
    ].join("\n"),
  );
  const left = plan.unfulfilled.map((id) => itemById(id)).filter(Boolean);
  return [...head, ...body, ...(left.length ? ["", `Not available: ${left.map(itemTitle).join(", ")}`] : [])].join("\n");
}

const FILL_TEXT = {
  queued: ["Waiting", "wait"],
  adding: ["Adding…", "busy"],
  added: ["Added", "ok"],
  partial: ["Partly added", "warn"],
  out_of_stock: ["Out of stock", "bad"],
  not_found: ["Not found", "bad"],
  failed: ["Could not add", "bad"],
  skipped: ["Not attempted", "off"],
};

function alternative(line, app) {
  const item = itemById(line.item_id);
  if (!item) return "";
  const others = Object.entries(offersFor(item)).filter(([a]) => a !== app).sort((a, b) => a[1].price - b[1].price);
  return others.length ? `Also on ${STORE_BY_ID[others[0][0]].label} for ${rupee(others[0][1].price)}.` : "";
}

function renderFill() {
  const show = ["filling", "done"].includes(S.phase) && S.plan;
  $("sec-fill").hidden = !show;
  if (!show) return setHtml("sec-fill", "");
  const all = S.plan.carts.flatMap((c) => c.lines.map((l) => ({ line: l, app: c.app, rec: S.fill[l.item_id] || { status: "queued" } })));
  const ok = all.filter((x) => x.rec.status === "added").length;
  const problems = all.filter((x) => !["added", "queued", "adding"].includes(x.rec.status));
  const done = S.phase === "done";

  const groups = S.plan.carts
    .map(
      (c) => `<div class="f-group" data-store="${c.app}">
      <header><span class="dot"></span><h3>${esc(STORE_BY_ID[c.app].label)}</h3>
        ${done ? `<button class="btn small" data-action="show-cart" data-store="${c.app}">Review cart</button>` : ""}</header>
      <ul>${c.lines
        .map((l) => {
          const rec = S.fill[l.item_id] || { status: "queued" };
          const [text, tone] = FILL_TEXT[rec.status] || FILL_TEXT.failed;
          const extra = rec.status === "added" ? (rec.detail === "Already in your cart." ? rec.detail : "") : rec.detail || "";
          const alt = ["out_of_stock", "not_found", "failed"].includes(rec.status) ? alternative(l, c.app) : "";
          return `<li class="tone-${tone}" data-item="${l.item_id}" data-status="${rec.status}"><span class="f-icon" aria-hidden="true"></span>
            <span class="f-name">${l.quantity}× ${esc(l.product_name)}${l.size_text ? ` <small>${esc(l.size_text)}</small>` : ""}
              ${extra || alt ? `<small class="f-detail">${esc([extra, alt].filter(Boolean).join(" "))}</small>` : ""}</span>
            <span class="f-status">${text}</span></li>`;
        })
        .join("")}</ul></div>`,
    )
    .join("");

  setHtml(
    "sec-fill",
    `<div class="card-head"><h2>${done ? "Cart report" : "Filling your carts"}</h2>
      <span class="hint" id="fill-summary" data-done="${ok + problems.length}" data-total="${all.length}">${done ? `${ok} of ${all.length} added${problems.length ? ` · ${problems.length} need${problems.length === 1 ? "s" : ""} attention` : ""}` : `${ok} of ${all.length} added so far`}</span></div>
    <div class="bar total" aria-hidden="true"><i style="width:${Math.round((100 * (ok + problems.length)) / Math.max(all.length, 1))}%"></i></div>
    ${groups}
    ${
      done
        ? `<div class="pay-note"><strong>Now it is your turn.</strong> Open each app, check the cart and pay there. CartPilot never pays for you.</div>
           <div class="actions"><button class="btn ghost" data-action="restart">Start a new list</button></div>`
        : ""
    }`,
  );
}

function renderLive() {
  if (IS_EXT) return;
  $("live").hidden = false;
  setHtml(
    "live-tabs",
    STORES.map((s) => {
      const tone = storeStatus(s.id).tone;
      return `<button role="tab" data-action="live-tab" data-store="${s.id}" aria-selected="${S.liveTab === s.id}" class="${S.liveTab === s.id ? "on" : ""} tone-${tone}"><i class="dot"></i>${esc(s.label)}</button>`;
    }).join(""),
  );
  $("live-open").href = `${apiBase()}/mock/${S.liveTab}/`;
  for (const frame of $("live-frames").children) frame.classList.toggle("on", frame.dataset.store === S.liveTab);
}

function render() {
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle("mode-extension", IS_EXT);
  renderHeader();
  renderSteps();
  renderList();
  renderStores();
  renderReview();
  renderPlan();
  renderFill();
  renderLive();
}

// ------------------------------------------------------------ talking to store pages

async function refreshStores() {
  try {
    S.stores = await transport.stores();
  } catch {
    S.stores = {};
  }
  render();
}

function settle(store, result) {
  const job = pending.get(store);
  if (!job) return;
  pending.delete(store);
  job.resolve(result);
}

/** Send a long-running command to one store and wait for its final event. */
function runStore(store, message) {
  return new Promise((resolve) => {
    const runId = uid();
    pending.set(store, { runId, resolve, last: Date.now() });
    transport
      .send(store, { ...message, runId })
      .then((ack) => {
        if (ack && ack.ok) return;
        const why = ack && ack.error === "busy" ? "This store tab is still busy with an earlier run." : "Could not reach the store page. Reload it and try again.";
        settle(store, { failed: true, message: why });
      })
      .catch(() => settle(store, { failed: true, message: "Could not reach the store page." }));
  });
}

setInterval(() => {
  for (const [store, job] of pending) {
    if (Date.now() - job.last > QUIET_LIMIT_MS) settle(store, { failed: true, message: "The store page stopped responding." });
  }
}, 2000);

transport.onEvent((event) => {
  if (event.evt === "ready") return void refreshStores();
  const job = pending.get(event.store);
  if (!job || job.runId !== event.runId) return;
  job.last = Date.now();
  if (event.evt === "progress") {
    S.activity[event.store] = { state: event.phase === "fill" ? "filling" : "collecting", index: event.index, total: event.total, itemId: event.itemId };
    if (event.phase === "fill" && event.state === "adding") S.fill[event.itemId] = { status: "adding" };
  } else if (event.evt === "line") {
    S.fill[event.itemId] = event;
  } else if (event.evt === "collected" || event.evt === "filled") {
    settle(event.store, event);
  } else if (event.evt === "error") {
    settle(event.store, { failed: true, message: event.message });
  }
  render();
});

// ------------------------------------------------------------ the flow

function resetRun() {
  Object.assign(S, { stopping: false, items: [], parseInfo: null, activity: {}, candidates: {}, fees: {}, feeSource: {}, matches: {}, choices: {}, expanded: {}, foldOpen: false, plan: null, planError: null, fill: {} });
}

async function start() {
  const text = $("list-input").value.trim();
  if (!text) {
    toast("Type a few groceries first.", "error");
    return $("list-input").focus();
  }
  saved.set("lastList", text);
  resetRun();
  S.phase = "parsing";
  render();
  try {
    const parsed = await api.parse(text);
    S.items = parsed.items;
    S.parseInfo = parsed;

    await refreshStores();
    const active = STORES.map((s) => s.id).filter((id) => S.stores[id] && S.stores[id].connected);
    if (!active.length) {
      throw new Error(IS_EXT ? "No store tab is open. Use the Open buttons under Stores, then run again." : "The mock stores are still loading. Try again in a moment.");
    }

    S.phase = "collecting";
    render();
    const query = S.items.map((i) => ({ id: i.id, query: i.search_query }));
    const results = await Promise.all(active.map((store) => runStore(store, { cmd: "collect", items: query, pace: settings.pace }).then((r) => [store, r])));
    let stopped = false;
    for (const [store, r] of results) {
      if (r.failed) {
        S.activity[store] = { state: "error", message: r.message };
        continue;
      }
      S.candidates[store] = r.results || {};
      if (r.fees) {
        S.fees[store] = { delivery_fee: 0, free_delivery_threshold: null, handling_fee: 0, small_cart_fee: 0, small_cart_threshold: 0, ...r.fees };
        S.feeSource[store] = r.feesSource;
      }
      const priced = Object.values(r.results || {}).filter((list) => list.length).length;
      const failed = Object.keys(r.errors || {}).length;
      if (r.blocked) S.activity[store] = { state: "blocked" };
      else if (r.stopped) S.activity[store] = { state: "stopped" };
      else S.activity[store] = { state: "collected", count: priced, tone: failed ? "warn" : "ok", message: failed ? `Prices read for ${priced} of ${S.items.length}; ${failed} search${failed === 1 ? "" : "es"} failed` : null };
      stopped = stopped || (r.stopped && !r.blocked);
    }
    if (stopped || S.stopping) {
      S.phase = "idle";
      S.stopping = false;
      toast("Stopped. Nothing was added to any cart.");
      return render();
    }
    const usable = Object.keys(S.candidates).filter((store) => S.fees[store]);
    if (!usable.length) throw new Error("No store returned prices. Check the store tabs and try again.");
    for (const store of Object.keys(S.candidates)) if (!S.fees[store]) delete S.candidates[store];

    S.phase = "matching";
    render();
    const matched = await api.match(S.items, S.candidates);
    S.matcher = matched.matcher;
    S.matches = Object.fromEntries(matched.matches.map((m) => [m.item_id, m]));
    applyMemory();
    S.phase = "review";
    render();
    if (unresolvedCount() === 0) await buildPlan();
    else $("sec-review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    S.phase = "idle";
    S.stopping = false;
    toast(error.message || "Something went wrong.", "error");
    render();
  }
}

async function buildPlan() {
  const payload = {
    items: S.items.map((item) => ({
      item_id: item.id,
      name: itemTitle({ ...item, quantity: 1 }),
      quantity: item.quantity,
      offers: Object.fromEntries(
        Object.entries(offersFor(item)).map(([app, p]) => [app, { product_id: p.id, name: p.name, unit_price: p.price, size_text: p.size_text }]),
      ),
    })),
    fees: S.fees,
    max_apps: S.options.maxApps || null,
    min_split_saving: S.options.minSaving || 0,
  };
  try {
    S.plan = await api.optimize(payload);
    S.planError = null;
  } catch (error) {
    S.plan = null;
    S.planError = error.message;
  }
  S.phase = "plan";
  render();
}

async function fillCarts() {
  if (S.phase !== "plan" || !S.plan || !S.plan.carts.length) return;
  S.phase = "filling";
  S.fill = {};
  for (const cart of S.plan.carts) for (const line of cart.lines) S.fill[line.item_id] = { status: "queued" };
  S.liveTab = S.plan.carts[0].app;
  render();
  $("sec-fill").scrollIntoView({ behavior: "smooth", block: "start" });

  const job = async (cart) => {
    if (S.stopping) return;
    await transport.focus(cart.app);
    const lines = cart.lines.map((l) => ({ itemId: l.item_id, productId: l.product_id, name: l.product_name, query: l.product_name, quantity: l.quantity }));
    const r = await runStore(cart.app, { cmd: "fill", lines, pace: settings.pace });
    const added = cart.lines.filter((l) => (S.fill[l.item_id] || {}).status === "added").length;
    if (r.failed) S.activity[cart.app] = { state: "error", message: r.message };
    else if (r.blocked) S.activity[cart.app] = { state: "blocked" };
    else S.activity[cart.app] = { state: "filled", tone: added === cart.lines.length ? "ok" : "warn", message: `${added} of ${cart.lines.length} added` };
    const reason = r.failed ? r.message : r.blocked ? "The store asked for a human check, so CartPilot stopped." : "Stopped before this item.";
    for (const line of cart.lines) {
      if (["queued", "adding"].includes((S.fill[line.item_id] || {}).status)) S.fill[line.item_id] = { status: "skipped", detail: reason };
    }
    render();
  };
  if (transport.sequentialFill) for (const cart of S.plan.carts) await job(cart);
  else await Promise.all(S.plan.carts.map(job));

  for (const cart of S.plan.carts) for (const line of cart.lines) {
    if ((S.fill[line.item_id] || {}).status === "queued") S.fill[line.item_id] = { status: "skipped", detail: "Stopped before this item." };
  }
  S.phase = "done";
  S.stopping = false;
  render();
}

function stop() {
  if (!busy()) return;
  S.stopping = true;
  for (const store of pending.keys()) transport.send(store, { cmd: "stop" });
  render();
}

// ------------------------------------------------------------ events

const actions = {
  start,
  stop,
  fill: fillCarts,
  sample(el) {
    $("list-input").value = SAMPLES[Number(el.dataset.index)].text;
    updateCount();
    $("list-input").focus();
  },
  pick(el) {
    const item = itemById(el.dataset.item);
    const variant = optionsFor(S.matches[item.id]).find((v) => v.key === el.dataset.key);
    if (!variant) return;
    S.choices[item.id] = { kind: "variant", key: variant.key, per_app: variant.per_app, label: variant.label };
    S.expanded[item.id] = false;
    saved.set("memory", { ...saved.get("memory", {}), [memoryKey(item)]: variant.key });
    afterChoice();
  },
  skip(el) {
    S.choices[el.dataset.item] = { kind: "skip" };
    S.expanded[el.dataset.item] = false;
    afterChoice();
  },
  unpick(el) {
    delete S.choices[el.dataset.item];
    afterChoice();
  },
  expand(el) {
    S.expanded[el.dataset.item] = !S.expanded[el.dataset.item];
    render();
  },
  "skip-rest"() {
    for (const item of S.items) if (needsPick(item)) S.choices[item.id] = { kind: "skip" };
    afterChoice();
  },
  "max-apps"(el) {
    S.options.maxApps = Number(el.dataset.value);
    buildPlan();
  },
  set(el) {
    settings[el.dataset.name] = el.dataset.value;
    saved.set(el.dataset.name, el.dataset.value);
    if (el.dataset.name === "source") refreshStores();
    render();
  },
  qty(el) {
    const item = itemById(el.dataset.item);
    if (!item || !canEdit()) return;
    item.quantity = Math.max(1, Math.min(50, item.quantity + Number(el.dataset.delta)));
    afterEdit();
  },
  "remove-item"(el) {
    if (!canEdit()) return;
    const id = el.dataset.item;
    S.items = S.items.filter((i) => i.id !== id);
    for (const bag of [S.matches, S.choices, S.expanded, ...Object.values(S.candidates)]) delete bag[id];
    if (!S.items.length) {
      resetRun();
      S.phase = "idle";
      return render();
    }
    afterEdit();
  },
  "save-list"() {
    const text = $("list-input").value.trim();
    if (!text) return;
    const parts = text.split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
    const name = `${parts.slice(0, 2).join(", ")}${parts.length > 2 ? ` +${parts.length - 2}` : ""}`.slice(0, 32);
    saved.set("lists", [{ name, text }, ...saved.get("lists", []).filter((l) => l.text !== text)].slice(0, 6));
    toast("List saved. It will be here next time.");
    render();
  },
  "load-list"(el) {
    const list = saved.get("lists", [])[Number(el.dataset.index)];
    if (!list) return;
    $("list-input").value = list.text;
    updateCount();
    render();
    $("list-input").focus();
  },
  "delete-list"(el) {
    const lists = saved.get("lists", []);
    lists.splice(Number(el.dataset.index), 1);
    saved.set("lists", lists);
    render();
  },
  "toggle-theme"() {
    settings.theme = darkNow() ? "light" : "dark";
    saved.set("theme", settings.theme);
    render();
  },
  async "record-start"(el) {
    const store = el.dataset.store;
    const reply = await transport.record(store, "start");
    if (!reply || !reply.ok) return toast("Could not start recording. Reload the store tab and try again.", "error");
    S.recording[store] = true;
    await transport.focus(store);
    render();
  },
  async "record-stop"(el) {
    const store = el.dataset.store;
    const reply = await transport.record(store, "stop");
    S.recording[store] = false;
    render();
    if (!reply || !reply.ok || !reply.data) return toast("Nothing was recorded. Start again and keep the store tab open.", "error");
    const { responses, actions } = reply.data;
    const blob = new Blob([JSON.stringify(reply.data, null, 1)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `cartpilot-capture-${store}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    toast(`Saved cartpilot-capture-${store}.json to Downloads (${responses.length} responses, ${actions.length} actions).`);
  },
  async "copy-plan"() {
    toast((await copyText(planAsText())) ? "Plan copied. Paste it anywhere." : "Could not copy the plan.");
  },
  forget() {
    saved.set("memory", {});
    toast("Remembered choices cleared.");
  },
  "open-store"(el) {
    transport.open(el.dataset.store).then(() => setTimeout(refreshStores, 1500));
  },
  "live-tab"(el) {
    S.liveTab = el.dataset.store;
    render();
  },
  "show-cart"(el) {
    S.liveTab = el.dataset.store;
    transport.focus(el.dataset.store);
    transport.send(el.dataset.store, { cmd: "showCart" });
    render();
  },
  restart() {
    resetRun();
    S.phase = "idle";
    $("list-input").value = "";
    updateCount();
    render();
    $("list-input").focus();
  },
};

/** Amounts or items changed: prices are already known, so only the plan needs solving again. */
function afterEdit() {
  if (unresolvedCount() === 0 && Object.keys(S.matches).length) return buildPlan();
  render();
}

function afterChoice() {
  if (unresolvedCount() === 0 && ["review", "plan"].includes(S.phase)) buildPlan();
  else {
    if (S.phase === "plan") S.phase = "review";
    render();
  }
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const handler = actions[el.dataset.action];
  if (!handler) return;
  // Handlers may be sync or async; either way a failure becomes a message, never a dead button.
  new Promise((resolve) => resolve(handler(el))).catch((error) => toast(error.message || "Something went wrong.", "error"));
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.fee) {
    const [app, key] = el.dataset.fee.split(".");
    const value = el.value === "" ? null : Math.max(0, Number(el.value));
    S.fees[app][key] = value === null && key !== "free_delivery_threshold" ? 0 : value;
    S.feeSource[app] = "edited";
    delete htmlCache["sec-plan"];
    buildPlan();
  } else if (el.id === "min-saving") {
    S.options.minSaving = Math.max(0, Number(el.value) || 0);
    buildPlan();
  } else if (el.id === "api-base") {
    settings.apiBase = el.value.trim() || "http://localhost:8000";
    saved.set("apiBase", settings.apiBase);
    checkHealth();
  }
});

// Remember only what the user did to the confirmed-products list (a click), not what a re-render did.
document.addEventListener("click", (event) => {
  const summary = event.target.closest(".fold > summary");
  if (summary) S.foldOpen = !summary.parentElement.open; // the click is about to flip it
});

function updateCount() {
  const n = $("list-input").value.split(/[,\n;]+/).filter((s) => /[a-z]/i.test(s)).length;
  $("list-count").textContent = n ? plural(n, "item") : "";
}
$("list-input").addEventListener("input", () => {
  updateCount();
  renderList(); // shows or hides "Save this list"
});
$("list-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy()) start();
});
document.addEventListener("click", (event) => {
  const menu = $("settings");
  if (menu.open && !menu.contains(event.target)) menu.open = false;
});

async function checkHealth() {
  try {
    S.health = await api.health();
  } catch {
    S.health = false;
  }
  renderHeader();
}

// ------------------------------------------------------------ boot

$("list-input").value = saved.get("lastList", "");
updateCount();
render();
checkHealth();
refreshStores();
setInterval(checkHealth, 15000);
setInterval(() => {
  if (!busy()) refreshStores();
}, 3000);

window.__cartpilot = { state: S }; // read-only handle for end-to-end tests and debugging
