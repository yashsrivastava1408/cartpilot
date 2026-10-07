"""CartPilot API.

    POST /parse     free text -> typed grocery items
    POST /match     items + per-app search results -> chosen products / "which one?"
    POST /optimize  matched offers + fees -> cheapest split (deterministic)

The same process also serves the web UI at /app/ and the offline mock stores at
/mock/{store}/, so the whole demo runs from one command with no internet.
"""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, mockstores
from .config import EXTENSION_DIR, STATIC_DIR, get_settings
from .embeddings import get_embedder
from .matching import match_items
from .models import MatchRequest, MatchResponse, OptimizeRequest, OptimizeResponse, ParseRequest, ParseResponse
from .optimizer import ILP_AVAILABLE, optimize
from .parsing import parse_list, resolve_provider

settings = get_settings()
logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("cartpilot.api")

app = FastAPI(
    title="CartPilot API",
    version=__version__,
    description="Grocery list optimiser for quick-commerce apps. The user always pays themselves.",
)

# The side panel runs on a chrome-extension:// origin; the web UI is same-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://[a-p]{32}|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
    expose_headers=["X-Request-ID"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    request.state.request_id = request_id
    started = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    path = request.url.path
    if not path.startswith(("/app/", "/ext/", "/mock-assets/")):
        log.info("%s %s -> %s in %.0fms [%s]", request.method, path, response.status_code,
                 (time.perf_counter() - started) * 1000, request_id)
    return response


def _error(request: Request, status: int, code: str, message: str, details: object = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message, "request_id": getattr(request.state, "request_id", None)}}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(status_code=status, content=body)


@app.exception_handler(RequestValidationError)
async def on_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    details = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
    first = details[0] if details else {"field": "", "message": "invalid request"}
    return _error(request, 422, "invalid_request", f"{first['field']}: {first['message']}".strip(": "), details)


@app.exception_handler(HTTPException)
async def on_http_error(request: Request, exc: HTTPException) -> JSONResponse:
    return _error(request, exc.status_code, "http_error", str(exc.detail))


@app.exception_handler(Exception)
async def on_unhandled(request: Request, exc: Exception) -> JSONResponse:
    log.exception("unhandled error [%s]", getattr(request.state, "request_id", "?"))
    return _error(request, 500, "internal_error", "Something went wrong on the server.")


@app.get("/healthz", tags=["meta"])
def healthz() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "parse_provider": resolve_provider(settings),
        "matcher": settings.matcher_name,
        "embedder": get_embedder(settings).name,
        "ilp_available": ILP_AVAILABLE,
        "confidence_threshold": settings.confidence_threshold,
    }


@app.post("/parse", response_model=ParseResponse, tags=["pipeline"])
def parse(body: ParseRequest) -> ParseResponse:
    items, provider, warnings = parse_list(body.text, settings)
    if not items:
        raise HTTPException(status_code=422, detail="Could not find any grocery items in that text.")
    return ParseResponse(items=items, provider=provider, warnings=warnings)


@app.post("/match", response_model=MatchResponse, tags=["pipeline"])
def match(body: MatchRequest) -> MatchResponse:
    return match_items(body, settings)


@app.post("/optimize", response_model=OptimizeResponse, tags=["pipeline"])
def optimize_route(body: OptimizeRequest) -> OptimizeResponse:
    return optimize(body, settings)


app.include_router(mockstores.router)
app.mount("/mock-assets", StaticFiles(directory=STATIC_DIR / "mock"), name="mock-assets")
if EXTENSION_DIR.is_dir():
    app.mount("/ext", StaticFiles(directory=EXTENSION_DIR / "src"), name="ext")
    app.mount("/app", StaticFiles(directory=EXTENSION_DIR / "panel", html=True), name="app")


@app.get("/", include_in_schema=False)
def root() -> RedirectResponse:
    return RedirectResponse("/app/")
