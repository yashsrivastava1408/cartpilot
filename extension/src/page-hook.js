/*
 * CartPilot page hook. Runs in the page's own JavaScript world.
 *
 * It wraps fetch and XMLHttpRequest so that when the site loads JSON for itself,
 * a copy is posted to the CartPilot content script. The page always receives its
 * original, untouched response. This file never makes a request of its own, never
 * changes a request, and never reads cookies, tokens or storage.
 */
(() => {
  if (window.__cartpilotHook) return;
  window.__cartpilotHook = true;

  const MAX_BYTES = 2_000_000;
  const isJson = (contentType) => /json/i.test(contentType || "");
  const absolute = (url) => {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return String(url);
    }
  };
  const forward = (meta, body) => {
    try {
      window.postMessage({ source: "cartpilot-hook", kind: "response", at: Date.now(), ...meta, body }, window.location.origin);
    } catch {
      /* a response that cannot be cloned is simply skipped */
    }
  };
  const bodyPreview = (body) => (typeof body === "string" ? body.slice(0, 2000) : null);

  const realFetch = window.fetch;
  window.fetch = function cartpilotFetch(input, init) {
    const pending = realFetch.apply(this, arguments);
    pending
      .then((response) => {
        if (!isJson(response.headers.get("content-type"))) return;
        const meta = {
          url: absolute(typeof input === "string" ? input : (input && input.url) || String(input)),
          method: String((init && init.method) || (input && input.method) || "GET").toUpperCase(),
          status: response.status,
          requestBody: bodyPreview(init && init.body),
        };
        response
          .clone()
          .text()
          .then((text) => {
            if (text.length <= MAX_BYTES) forward(meta, JSON.parse(text));
          })
          .catch(() => {});
      })
      .catch(() => {});
    return pending;
  };

  const realOpen = XMLHttpRequest.prototype.open;
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function cartpilotOpen(method, url) {
    this.__cartpilot = { method: String(method).toUpperCase(), url: absolute(url) };
    return realOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function cartpilotSend(body) {
    const meta = this.__cartpilot;
    if (meta) {
      meta.requestBody = bodyPreview(body);
      this.addEventListener("load", () => {
        try {
          if (!isJson(this.getResponseHeader("content-type"))) return;
          let data;
          if (this.responseType === "json") data = this.response;
          else if (this.responseType === "" || this.responseType === "text") {
            if (this.responseText.length > MAX_BYTES) return;
            data = JSON.parse(this.responseText);
          } else return;
          forward({ ...meta, status: this.status }, data);
        } catch {
          /* not JSON after all */
        }
      });
    }
    return realSend.apply(this, arguments);
  };
})();
