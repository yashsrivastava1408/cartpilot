# Development guide

## Requirements

| Tool | Version | For |
|---|---|---|
| Python | 3.11 | Backend |
| Node.js | 20 or newer | Browser tests only |
| Chrome | 116 or newer | The extension |

## Setup

```bash
make setup
```

which is the same as:

```bash
python3.11 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements-dev.txt
cd e2e && npm install && npx playwright install chromium
```

## Everyday commands

| Command | Does |
|---|---|
| `make run` | Backend, web UI and mock stores on http://localhost:8000 |
| `make test` | Backend tests (about 3 seconds) |
| `make e2e` | Browser tests (about 2 minutes). Starts the backend itself if needed |
| `make check` | Both |
| `make icons` | Regenerate the extension icons |

Useful URLs while running: `/` (web UI), `/docs` (API explorer), `/healthz`,
`/mock/zepto/` (a mock store on its own).

## Configuration

Copy `backend/.env.example` to `backend/.env`. Restart the backend after editing.
`.env` is hidden in Finder: press Cmd + Shift + . to show it.

| Variable | Default | Meaning |
|---|---|---|
| `CARTPILOT_PARSE_PROVIDER` | `auto` | `auto`, `rules`, `groq` or `anthropic`. Auto prefers Groq, then Anthropic, then rules |
| `GROQ_API_KEY` | — | Turns on Groq for parsing, and for matching when no Jev key is set |
| `CARTPILOT_GROQ_MODEL` | `openai/gpt-oss-120b` | Must be a model your Groq account lists |
| `CARTPILOT_GROQ_REASONING` | `low` for gpt-oss models | Thinking effort; leave empty for models without it |
| `ANTHROPIC_API_KEY` | — | Claude Haiku for parsing |
| `CARTPILOT_PARSE_MODEL` | `claude-haiku-4-5` | Claude model for parsing |
| `JEV_API_KEY` / `OPENROUTER_API_KEY` | — | Jev for matching (wins over Groq) |
| `JEV_MODEL`, `JEV_BASE_URL` | `typesafe/jev-1.13`, OpenRouter | Any OpenAI-compatible chat endpoint |
| `EMBEDDINGS_API_KEY` | — | Hosted embeddings for the shortlist |
| `CARTPILOT_CONFIDENCE_THRESHOLD` | `0.8` | Below this, ask the user |
| `CARTPILOT_SHORTLIST_SIZE` | `5` | Candidates passed to the chooser |
| `CARTPILOT_EXHAUSTIVE_LIMIT` | `200000` | Search nodes before the ILP takes over |
| `CARTPILOT_LLM_TIMEOUT_S` | `20` | Per model request |
| `CARTPILOT_LOG_LEVEL` | `INFO` | |

`/healthz` shows which providers are actually active.

## Project layout

```
backend/
  cartpilot/
    main.py           routes, error handling, static mounts
    config.py         settings from the environment
    models.py         every request and response model
    units.py          pack-size parsing (g / ml / pcs)
    parsing.py        parse_list() and its providers
    embeddings.py     local and hosted embedders
    matching.py       shortlist, choosers, variants, substitutes
    optimizer.py      pruned search + ILP
    mockstores.py     three mock storefronts
    fixtures/         catalog.json (70 products), stores.json (fees)
    static/mock/      the mock storefront page
  tests/
extension/
  manifest.json, background.js
  src/                page-hook, adapters, driver, recorder, content, embed-bridge
  panel/              index.html, app.js, api.js, transport.js, styles.css
e2e/
  tests/              web-demo, extension, adapters
docs/
```

## Tests

| Suite | Count | What it covers |
|---|---|---|
| `backend/tests/test_units_parsing.py` | 45 | Sizes, the rule parser, provider selection and fallbacks, Groq and Claude request shapes (with fakes) |
| `backend/tests/test_matching.py` | 26 | Scoring, shortlist, choosers, variants, substitutes, batching, retry, cache |
| `backend/tests/test_optimizer.py` | 115 | Cost model, edge cases, both solvers against an independent brute force |
| `backend/tests/test_api.py` | 16 | Endpoints, validation, errors, CORS, the mock stores, the full pipeline |
| `e2e/tests/web-demo.spec.js` | 21 | The whole flow in a browser, item editing, saved lists, theme, controls, stop, pacing, failures, layout |
| `e2e/tests/extension.spec.js` | 4 | The real extension in Chromium: collect, fill, recorder, no-tabs state |
| `e2e/tests/adapters.spec.js` | 5 | `normalize()` per store, the heuristic reader, page matching |

Tests never reach a real model: keys are blanked in `backend/tests/conftest.py`
and in `e2e/playwright.config.js`.

Run one thing:

```bash
cd backend && .venv/bin/python -m pytest tests/test_optimizer.py -q
cd e2e && npx playwright test tests/web-demo.spec.js -g "remembers"
```

## Adding things

**A parse provider.** Write `parse_with_x(text, settings) -> list[GroceryItem]` in
`parsing.py`, add it to `PROVIDERS`, and add its key to `_key_for`.

**A store.** Add an adapter object to `CP.adapters` in `src/adapters.js`, add its
host to `manifest.json` (both `host_permissions` and `content_scripts`), and add it
to `STORES` in `panel/transport.js` and `backend/cartpilot/config.py`.

**A mock product.** Add an entry to `backend/cartpilot/fixtures/catalog.json` and
restart the backend.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Backend offline" in the header | Backend not running, or wrong URL in settings | `make run`; check the Backend URL in the panel settings |
| Header says "offline matching" although a key is set | `.env` not saved, or backend not restarted | Save, restart, check `/healthz` |
| A yellow "parser was unavailable" note | The model call failed (bad model name, rate limit) | Check the backend log; confirm the model name with your provider |
| Store shows "Not open in a tab" | No tab for it, or the tab predates the extension | Press **Open**, or reload the store tab |
| Changes to the extension do nothing | Chrome is running the old copy | Reload the extension card, then the store tabs |
| Port 8000 is taken | Another process | `lsof -iTCP:8000 -sTCP:LISTEN`, stop it, or change the port in the command **and** the manifest |
| ILP tests are skipped | CBC solver not runnable on this machine | The pruned search still gives exact answers |

## Known gaps

- **Live stores are untested.** See [EXTENSION.md](EXTENSION.md#going-live).
- **Claude and Jev paths** are tested with fakes only. `typesafe-sdk` is not used; Jev
  is called through an OpenAI-style chat endpoint behind the `Chooser` interface.
- **Dockerfile** is written but was never built.
- **Pack-size maths is simple.** "12 bananas" is not satisfied by two packs of six; the UI asks.
- **No resume across page reloads** in the driver.
- **Mock carts are in memory** and reset on restart.
- **No licence file** yet.
