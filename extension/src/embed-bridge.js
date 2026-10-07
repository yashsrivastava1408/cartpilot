/*
 * Web-demo bridge. When a mock store is shown inside the CartPilot web app (an
 * iframe on the same origin), this connects the driver to the parent page with
 * postMessage, so the demo works without installing the extension.
 */
(() => {
  const CP = globalThis.CartPilot;
  if (!CP || window.parent === window) return;
  const adapter = CP.pickAdapter(window.location);
  if (!adapter || !adapter.mock) return;

  const origin = window.location.origin;
  const toParent = (message) => window.parent.postMessage({ ...message, source: "cartpilot-driver" }, origin);
  const driver = CP.createDriver({ adapter, emit: toParent });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window.parent || event.origin !== origin) return;
    if (!message || message.target !== "cartpilot-driver") return;
    toParent({ evt: "ack", replyTo: message.msgId, store: adapter.store, ...driver.handle(message) });
  });

  toParent({ evt: "ready", ...driver.info() });
})();
