# The rules CartPilot plays by

These were fixed before any code was written, and they are enforced in code, not
just promised in a README.

| # | Rule | Where it is enforced | How it is tested |
|---|---|---|---|
| 1 | Data comes only from the user's own logged-in browser tab | `page-hook.js` only copies responses the page itself requested. It makes no request, changes no request, and reads no cookies or storage | The hook is checked to live in the page's world, separate from the content script |
| 2 | Human pace on live stores: one item at a time, 1.5 to 3 s apart | `driver.js` → `paceFor()` returns the human pace for every non-mock adapter, whatever the UI asks for | A browser test measures the gap between searches and requires at least 1.5 s |
| 3 | No CAPTCHA, OTP or bot-check bypass | `driver.js` → `checkpoint()` runs before every action. If a challenge is on the page the run stops and reports "blocked" | A test injects a fake human-check and confirms the run stops with an empty cart |
| 4 | Cart filling is visible clicks on the real Add button | `driver.js` → `fillLine()` scrolls to the card, outlines it and calls `click()` on the page's own button. No cart API is called by CartPilot | Tests read the store's own cart afterwards and compare it to the plan |
| 5 | Payment is never automated | No code refers to checkout or payment. The driver's only cart-related actions are Add and + | A test confirms the pay button is present and was not clicked |
| 6 | No stored passwords | The user logs in by hand. Nothing in the extension or backend handles credentials | The manifest test rejects `cookies` and similar permissions |
| 7 | No proxies, no fingerprint tricks | Not present. The manifest asks only for `sidePanel`, `tabs`, `storage` and the store hosts | Manifest test |
| 8 | The demo works fully offline | Mock stores and fixtures are served by the backend; every LLM path has a deterministic fallback | The whole test suite runs with all keys blanked |
| 9 | The optimiser never uses an LLM | `optimizer.py` imports no model code | Checked against an independent brute force |
| 10 | Unsure means ask | Below 0.8 confidence an item is `needs_user`; "none of these" is always offered | Browser tests for the "which one?" cards and skip |

## The setup recorder

The recorder is the one place raw store data is saved to disk, so it has its own
rules: no headers, no cookies, personal-looking fields replaced with `"[removed]"`,
lists cut to three samples, and the file never leaves the computer unless you send
it. See [EXTENSION.md](EXTENSION.md#going-live).

## What the rules do not cover

Following these rules keeps CartPilot polite and transparent. It does not make
live use permitted by a store's terms of service; that is each store's call. This
is a fun project: keep any live use personal and small.
