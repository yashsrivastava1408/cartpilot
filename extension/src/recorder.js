/*
 * CartPilot setup recorder.
 *
 * Used once per live store to learn its shape. While recording, it keeps a trimmed,
 * privacy-scrubbed copy of the JSON the page loads (the same copies page-hook.js
 * already makes) and notes which elements the user typed into and clicked. Nothing
 * is sent anywhere: the panel saves the result as a file on this computer.
 *
 * It never records request headers, cookies or tokens, and it drops any field whose
 * name looks personal (phone, email, address, location, user, token ...).
 */
(() => {
  const CP = (globalThis.CartPilot = globalThis.CartPilot || {});
  const KEY = "cartpilot-recording";
  const PERSONAL = /phone|mobile|email|address|addr|token|auth|secret|password|otp|session|cookie|lat|lng|lon|geo|pincode|pin_code|user|customer|profile|account|payment|card|upi|wallet/i;
  const MAX_ENTRIES = 60;

  /** Keep the structure, drop personal fields, cut long text and long lists. */
  function scrub(value, depth = 0) {
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 160)}…` : value;
    if (depth > 12) return "[deeper]";
    if (Array.isArray(value)) {
      const kept = value.slice(0, 3).map((v) => scrub(v, depth + 1));
      if (value.length > 3) kept.push(`[+${value.length - 3} more like these]`);
      return kept;
    }
    if (typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = PERSONAL.test(k) ? "[removed]" : scrub(v, depth + 1);
      return out;
    }
    return undefined;
  }

  const cleanUrl = (url) => {
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) if (PERSONAL.test(k)) u.searchParams.set(k, "[removed]");
      return u.href;
    } catch {
      return String(url).slice(0, 300);
    }
  };

  function describe(el) {
    const chain = [];
    for (let node = el, i = 0; node && node.nodeType === 1 && i < 5; node = node.parentElement, i++) {
      const attrs = {};
      for (const a of node.attributes) if (!/^(value|style)$/.test(a.name)) attrs[a.name] = a.value.slice(0, 120);
      chain.push({ tag: node.tagName.toLowerCase(), attrs, text: i < 2 ? (node.textContent || "").trim().slice(0, 80) : undefined });
    }
    return chain;
  }

  const load = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  };
  const save = (data) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      data.responses = data.responses.slice(-20); // storage full: keep the newest
      try {
        sessionStorage.setItem(KEY, JSON.stringify(data));
      } catch {
        /* give up on persisting; the in-memory copy still works until a reload */
      }
    }
  };

  let rec = load(); // survives page reloads inside the tab

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!rec || event.source !== window || !m || m.source !== "cartpilot-hook" || m.kind !== "response") return;
    rec.responses.push({
      at: Date.now() - rec.startedAt,
      page: window.location.pathname,
      method: m.method,
      status: m.status,
      url: cleanUrl(m.url),
      requestBody: m.requestBody ? scrub(safeJson(m.requestBody)) : null,
      body: scrub(m.body),
    });
    if (rec.responses.length > MAX_ENTRIES) rec.responses.shift();
    save(rec);
  });

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return String(text).slice(0, 300);
    }
  }

  const note = (kind) => (event) => {
    if (!rec || !(event.target instanceof Element)) return;
    const el = kind === "typed" ? event.target : event.target.closest('button, a, [role="button"], input') || event.target;
    if (kind === "typed" && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
    const last = rec.actions[rec.actions.length - 1];
    if (kind === "typed" && last && last.kind === "typed") return void (last.at = Date.now() - rec.startedAt); // one entry per burst of typing
    rec.actions.push({ at: Date.now() - rec.startedAt, kind, page: window.location.pathname, element: describe(el) });
    if (rec.actions.length > 40) rec.actions.shift();
    save(rec);
  };
  document.addEventListener("input", note("typed"), true);
  document.addEventListener("click", note("clicked"), true);

  CP.recorder = {
    handle(message, adapter) {
      if (message.cmd === "start") {
        rec = { store: adapter ? adapter.store : null, host: window.location.host, startedAt: Date.now(), version: CP.VERSION, actions: [], responses: [] };
        save(rec);
        return { ok: true, recording: true };
      }
      if (message.cmd === "status") return { ok: true, recording: Boolean(rec), responses: rec ? rec.responses.length : 0, actions: rec ? rec.actions.length : 0 };
      if (message.cmd === "stop") {
        const data = rec;
        rec = null;
        sessionStorage.removeItem(KEY);
        return { ok: Boolean(data), data };
      }
      return { ok: false };
    },
  };
})();
