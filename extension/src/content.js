/*
 * CartPilot content script. Connects the side panel to the driver in this tab.
 * Runs in the extension's isolated world; page-hook.js runs in the page's world.
 */
(() => {
  const CP = globalThis.CartPilot;
  if (!CP || globalThis.__cartpilotContent) return;
  globalThis.__cartpilotContent = true;

  // Background tabs have their timers slowed down by the browser. Racing a local
  // timer against one kept by the extension's service worker keeps the pace steady.
  const sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
      try {
        chrome.runtime.sendMessage({ type: "cartpilot-sleep", ms }).then(resolve, () => {});
      } catch {
        /* extension reloaded; the local timer still fires */
      }
    });

  const emit = (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      /* panel closed or extension reloaded */
    }
  };

  let driver = null;
  let driverFor = null;
  // Chosen lazily: single-page sites change path without reloading (e.g. swiggy.com -> /instamart).
  function currentDriver() {
    const adapter = CP.pickAdapter(window.location);
    if (!adapter) return null;
    if (driverFor !== adapter.id) {
      driver = CP.createDriver({ adapter, emit, sleep });
      driverFor = adapter.id;
    }
    return driver;
  }
  currentDriver(); // start listening for hook messages straight away

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.target === "cartpilot-recorder") {
      sendResponse(CP.recorder.handle(message, CP.pickAdapter(window.location)));
      return false;
    }
    if (!message || message.target !== "cartpilot-driver") return false;
    const active = currentDriver();
    sendResponse(active ? active.handle(message) : { ok: false, error: "no adapter for this page" });
    return false;
  });
})();
