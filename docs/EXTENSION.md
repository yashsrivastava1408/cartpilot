# The Chrome extension

A Manifest V3 extension. It is the only part of CartPilot that touches a store's
website, and it does so inside your own logged-in tab.

## Files

| File | Runs in | Job |
|---|---|---|
| `manifest.json` | — | Permissions, which pages get which scripts |
| `background.js` | Service worker | Opens the side panel; steady timers for background tabs |
| `src/page-hook.js` | The page's own world | Copies JSON the page loads for itself |
| `src/adapters.js` | Content script | Per-store knowledge and `normalize()` |
| `src/driver.js` | Content script | Search, collect, fill, verify |
| `src/recorder.js` | Content script | One-time setup capture for a live store |
| `src/content.js` | Content script | Routes panel messages to the driver or recorder |
| `src/embed-bridge.js` | Mock store page (web demo only) | The same routing over `postMessage` |
| `panel/` | Side panel | The UI |

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | Show the UI beside the page |
| `tabs` | Find which open tabs are stores, and bring one to the front while filling |
| `storage` | Reserved for settings |
| Host access to the three stores and `localhost:8000` | Run the scripts there and call the backend |

It does not ask for `cookies`, `webRequest`, `proxy`, `debugger` or all-sites access,
and a test fails if any of those appear in the manifest.

## Install

1. Start the backend: `make run`.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → choose the `extension/` folder.
4. Click the CartPilot toolbar icon to open the side panel.

After changing any extension file, press the reload icon on its card in
`chrome://extensions` and reload the store tabs.

## How the driver works

### Collecting prices

For each item, one at a time:

1. Find the store's search box (opening it first if the site hides it behind a button).
2. Type the query. A real `input` event is fired after setting the value with the
   native setter, which is what frameworks like React listen for.
3. Press Enter.
4. Wait for the page's own search response, copied by the hook. The response that
   mentions the query is preferred; failing that, the latest one after Enter.
5. Run the adapter's `normalize()` and keep up to 20 products.
6. Wait 1.5 to 3 seconds, then the next item.

Fees come from the store's own config response when the adapter can read one;
otherwise from the adapter's `defaultFees`, which the UI marks as "placeholder,
please check".

### Filling a cart

For each planned product:

1. Search for it by name so its card is on screen.
2. Find the card (by product id on the mock stores; by visible name where no selector is known).
3. Scroll to it and outline it in green, so you can see what is about to be clicked.
4. If it shows "out of stock", report that and move on.
5. Click **Add**. For quantity above 1, click **+** until the count is right.
6. Confirm: the cart response is preferred (`verified: "network"`), the stepper on
   the page is the fallback (`verified: "ui"`).
7. Report one of: `added`, `partial`, `out_of_stock`, `not_found`, `failed`.

A banner at the bottom of the store page says CartPilot is working there.
Checkout and payment are never touched.

### Background tabs

Browsers slow down timers in tabs you are not looking at. The content script races
its own timer against one kept by the service worker, so pacing stays steady while
prices are collected in the background. For filling, each store's tab is brought to
the front in turn.

## Adapters

An adapter is a plain object. This is the whole contract:

```js
{
  id: "mock-zepto",
  store: "zepto",                       // which app this is
  label: "Zepto (mock)",
  mock: true,                           // only mock adapters may use the fast demo pace
  matches: (location) => boolean,       // does this adapter handle this page?
  submit: "form" | "enter" | "none",    // how a search is submitted
  selectors: {
    searchInput, searchTrigger,         // the search box, and a button that reveals it
    productCard, addButton, incButton,  // inside a product card
    qtyValue, soldOut, cartButton,
  },
  search: {
    isResponse: (url, method) => boolean,   // is this the page's search response?
    normalize: (json) => Product[],         // store JSON → common product shape
  },
  cart: {
    isResponse: (url, method) => boolean,
    parse: (body, status) => ({ ok, code, quantities }),
  },
  config: { isResponse, parseFees } | null, // optional: read fees from the page
  defaultFees: { ... } | null,
  cardFor: (document, line) => Element | null,  // null = find the card by its name
}
```

Any selector left as `null` falls back to a generic lookup (for example, a button
whose text is exactly "Add"). The three mock adapters fill in everything; the three
live adapters are mostly fallbacks, marked `TODO(devtools)`.

## Going live

The live adapters have **never been run against the real sites**. To calibrate one:

### 1. Record the store's shape

1. In the side panel: settings → **Store pages** → **Live**.
2. Open the store, log in yourself, set your address.
3. Under **Stores**, press **Record setup** next to that store.
4. In the store tab: search for "milk", wait for results, click **Add** on one product.
5. Back in the panel: press **Save recording**.

A file named `cartpilot-capture-<store>.json` is saved to Downloads. It holds:

- the URL, method and trimmed JSON of each response the page loaded
- the request body of each (trimmed)
- which elements were typed into and clicked: tag and attributes, not the text typed

What it leaves out, by design:

| Never recorded | How |
|---|---|
| Request headers, cookies, tokens | The hook never sees or copies them |
| Personal fields | Any key that looks like phone, email, address, location, user, payment or token becomes `"[removed]"`, in bodies and in URLs |
| Whole product lists | Lists are cut to 3 samples plus a "+N more" note |
| Long text | Strings are cut at 160 characters |

Nothing is uploaded. Read the file before sharing it anyway.

### 2. Fill in the adapter

From the capture, in `src/adapters.js`:

1. `search.isResponse`: a pattern for the search response's URL.
2. `search.normalize`: the real field paths (copy the style of the mock adapters).
   If prices come back in paise, divide by 100.
3. `selectors`: the search box and the Add button, from the recorded elements.
4. `cart.isResponse` and `cart.parse`: the add-to-cart response and where quantities are.

### 3. Check the fees

Open "Fees used in this plan" in the panel and correct the delivery fee,
free-delivery threshold and handling fee from a real checkout bill.

### Things that will bite

- **Sites change.** Expect to revisit the adapter when a store redesigns.
- **Full page reloads.** If a store reloads the whole page on search, the run stops
  for that item; the driver does not resume across reloads.
- **Bot checks.** If one appears the run stops. That is intended.
- **Terms of service.** Automating a store's site may break its terms. Personal use only.
- **Port.** The manifest names `localhost:8000`. Change both if you move the backend.
