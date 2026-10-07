// Thin client for the CartPilot backend. Every failure becomes an Error with a plain message.

export function createApi(getBase) {
  async function call(method, path, body, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${getBase()}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        error.name === "AbortError"
          ? "The CartPilot backend took too long to answer."
          : "Cannot reach the CartPilot backend. Is it running on " + getBase() + "?",
      );
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* non-JSON error body */
    }
    if (!response.ok) {
      throw new Error((data && data.error && data.error.message) || `The backend returned an error (${response.status}).`);
    }
    return data;
  }

  return {
    health: () => call("GET", "/healthz", null, 5000),
    parse: (text) => call("POST", "/parse", { text }),
    match: (items, candidates) => call("POST", "/match", { items, candidates }, 90000),
    optimize: (payload) => call("POST", "/optimize", payload),
  };
}
