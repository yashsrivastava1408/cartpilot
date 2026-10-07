"""Runtime settings, read once from environment variables (and an optional .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = BACKEND_DIR.parent
EXTENSION_DIR = Path(os.environ.get("CARTPILOT_EXTENSION_DIR", REPO_DIR / "extension"))
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
STATIC_DIR = Path(__file__).resolve().parent / "static"

STORES = ("zepto", "blinkit", "instamart")


@dataclass(frozen=True)
class Settings:
    parse_provider: str  # auto | rules | groq | anthropic
    parse_model: str
    anthropic_api_key: str | None
    groq_api_key: str | None
    groq_model: str
    groq_base_url: str
    groq_reasoning_effort: str | None  # only sent to models that accept it
    jev_api_key: str | None
    jev_model: str
    jev_base_url: str
    matcher_name: str  # jev | groq | fuzzy
    embeddings_api_key: str | None
    embeddings_base_url: str
    embeddings_model: str
    confidence_threshold: float
    shortlist_size: int
    exhaustive_limit: int
    llm_timeout_s: float
    log_level: str

    @property
    def jev_enabled(self) -> bool:
        return bool(self.jev_api_key)


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@lru_cache
def get_settings() -> Settings:
    load_dotenv(BACKEND_DIR / ".env")
    jev_key = os.environ.get("JEV_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    groq_key = os.environ.get("GROQ_API_KEY") or None
    groq_model = os.environ.get("CARTPILOT_GROQ_MODEL", "openai/gpt-oss-120b")
    groq_url = os.environ.get("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
    jev_model = os.environ.get("JEV_MODEL", "typesafe/jev-1.13")
    jev_url = os.environ.get("JEV_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
    matcher_name = "jev" if jev_key else "fuzzy"
    if not jev_key and groq_key:
        # No Jev access: the same chooser runs on Groq (both speak the OpenAI chat format).
        jev_key, jev_model, jev_url, matcher_name = groq_key, groq_model, groq_url, "groq"
    return Settings(
        parse_provider=os.environ.get("CARTPILOT_PARSE_PROVIDER", "auto").lower(),
        parse_model=os.environ.get("CARTPILOT_PARSE_MODEL", "claude-haiku-4-5"),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        groq_api_key=groq_key,
        groq_model=groq_model,
        groq_base_url=groq_url,
        groq_reasoning_effort=os.environ.get("CARTPILOT_GROQ_REASONING", "low" if "gpt-oss" in groq_model else "") or None,
        jev_api_key=jev_key or None,
        jev_model=jev_model,
        jev_base_url=jev_url,
        matcher_name=matcher_name,
        embeddings_api_key=os.environ.get("EMBEDDINGS_API_KEY") or None,
        embeddings_base_url=os.environ.get("EMBEDDINGS_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/"),
        embeddings_model=os.environ.get("EMBEDDINGS_MODEL", "openai/text-embedding-3-small"),
        confidence_threshold=_float("CARTPILOT_CONFIDENCE_THRESHOLD", 0.8),
        shortlist_size=_int("CARTPILOT_SHORTLIST_SIZE", 5),
        exhaustive_limit=_int("CARTPILOT_EXHAUSTIVE_LIMIT", 200_000),
        llm_timeout_s=_float("CARTPILOT_LLM_TIMEOUT_S", 20.0),
        log_level=os.environ.get("CARTPILOT_LOG_LEVEL", "INFO").upper(),
    )
