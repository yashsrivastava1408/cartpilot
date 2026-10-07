// How the UI reaches the store pages.
//   EmbedTransport      web demo: mock stores in same-origin iframes, driven over postMessage
//   ExtensionTransport  side panel: real or mock store tabs, driven through the content script
// Both expose: stores(), send(store, message), focus(store), open(store), onEvent(callback).

export const STORES = [
  { id: "zepto", label: "Zepto", live: "https://www.zepto.com/" },
  { id: "blinkit", label: "Blinkit", live: "https://blinkit.com/" },
  { id: "instamart", label: "Instamart", live: "https://www.swiggy.com/instamart" },
];

const uid = () => Math.random().toString(36).slice(2, 10);

export class EmbedTransport {
  mode = "embed";
  sequentialFill = false;

  constructor(framesEl, base) {
    this.base = base;
    this.frames = {};
    this.ready = {};
    this.acks = new Map();
    this.listener = () => {};
    for (const store of STORES) {
      const frame = document.createElement("iframe");
      frame.title = `${store.label} mock store`;
      frame.dataset.store = store.id;
      frame.src = `${base}/mock/${store.id}/`;
      framesEl.appendChild(frame);
      this.frames[store.id] = frame;
    }
    window.addEventListener("message", (event) => {
      const m = event.data;
      if (event.origin !== window.location.origin || !m || m.source !== "cartpilot-driver") return;
      const store = STORES.find((s) => this.frames[s.id].contentWindow === event.source);
      if (!store) return;
      if (m.evt === "ready") this.ready[store.id] = m;
      if (m.evt === "ack") {
        const resolve = this.acks.get(m.replyTo);
        this.acks.delete(m.replyTo);
        if (resolve) resolve(m);
        return;
      }
      this.listener({ ...m, store: store.id });
    });
  }

  onEvent(callback) {
    this.listener = callback;
  }

  async stores() {
    return Object.fromEntries(
      STORES.map((s) => [s.id, { connected: Boolean(this.ready[s.id]), mock: true, label: s.label, url: `${this.base}/mock/${s.id}/` }]),
    );
  }

  send(store, message) {
    return new Promise((resolve) => {
      const msgId = uid();
      const timer = setTimeout(() => {
        this.acks.delete(msgId);
        resolve({ ok: false, error: "no reply" });
      }, 4000);
      this.acks.set(msgId, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      this.frames[store].contentWindow.postMessage({ ...message, target: "cartpilot-driver", msgId }, window.location.origin);
    });
  }

  async focus() {}
  async open(store) {
    window.open(`${this.base}/mock/${store}/`, "_blank", "noopener");
  }
}

export class ExtensionTransport {
  mode = "extension";
  sequentialFill = true; // one store at a time, with its tab in front, so the user can watch

  constructor(getBase, getSource) {
    this.getBase = getBase;
    this.getSource = getSource;
    this.tabs = {};
    this.listener = () => {};
    chrome.runtime.onMessage.addListener((m, sender) => {
      if (!m || m.source !== "cartpilot-driver" || !sender.tab) return false;
      const known = this.tabs[m.store];
      if (known && known.tabId === sender.tab.id) this.listener(m);
      return false;
    });
  }

  onEvent(callback) {
    this.listener = callback;
  }

  async stores() {
    const wantMock = this.getSource() === "mock";
    const found = {};
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab.id || !/^https?:/.test(tab.url || "")) return;
        try {
          const info = await chrome.tabs.sendMessage(tab.id, { target: "cartpilot-driver", cmd: "ping" });
          if (!info || !info.ok || info.mock !== wantMock) return;
          const current = found[info.store];
          if (!current || tab.active) found[info.store] = { ...info, tabId: tab.id, windowId: tab.windowId };
        } catch {
          /* no content script in this tab */
        }
      }),
    );
    this.tabs = found;
    return Object.fromEntries(
      STORES.map((s) => [
        s.id,
        { connected: Boolean(found[s.id]), mock: wantMock, label: s.label, url: this.urlFor(s.id), busy: Boolean(found[s.id] && found[s.id].busy) },
      ]),
    );
  }

  urlFor(store) {
    return this.getSource() === "mock" ? `${this.getBase()}/mock/${store}/` : STORES.find((s) => s.id === store).live;
  }

  async send(store, message) {
    const tab = this.tabs[store];
    if (!tab) return { ok: false, error: "not connected" };
    try {
      return await chrome.tabs.sendMessage(tab.tabId, { ...message, target: "cartpilot-driver" });
    } catch {
      return { ok: false, error: "not connected" };
    }
  }

  /** Talk to the setup recorder in a store tab (extension only). */
  async record(store, cmd) {
    const tab = this.tabs[store];
    if (!tab) return { ok: false };
    try {
      return await chrome.tabs.sendMessage(tab.tabId, { target: "cartpilot-recorder", cmd });
    } catch {
      return { ok: false };
    }
  }

  async focus(store) {
    const tab = this.tabs[store];
    if (!tab) return;
    try {
      await chrome.tabs.update(tab.tabId, { active: true });
    } catch {
      /* tab was closed */
    }
  }

  async open(store) {
    await chrome.tabs.create({ url: this.urlFor(store), active: false });
  }
}
