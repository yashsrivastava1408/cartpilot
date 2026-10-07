"""Embeddings used to shortlist candidates before the chooser runs.

The default embedder is local and deterministic (hashed word + character n-grams),
so the demo needs no network. Set EMBEDDINGS_API_KEY to use a hosted model through
any OpenAI-compatible ``/embeddings`` endpoint instead.
"""

from __future__ import annotations

import logging
import math
import re
import zlib
from typing import Protocol

import httpx

from .config import Settings

log = logging.getLogger("cartpilot.embed")


class Embedder(Protocol):
    name: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _normalise(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    return [v / norm for v in vec] if norm else vec


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity of two already-normalised vectors."""
    return sum(x * y for x, y in zip(a, b, strict=False))


class LocalHashEmbedder:
    name = "local-hash"

    def __init__(self, dim: int = 512) -> None:
        self.dim = dim

    def _features(self, text: str) -> list[tuple[str, float]]:
        clean = re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()
        feats: list[tuple[str, float]] = []
        for word in clean.split():
            feats.append((f"w:{word}", 2.0))
            padded = f"^{word}$"
            feats.extend((f"c:{padded[i : i + 3]}", 1.0) for i in range(len(padded) - 2))
        return feats

    def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for text in texts:
            vec = [0.0] * self.dim
            for feat, weight in self._features(text):
                h = zlib.crc32(feat.encode())
                vec[h % self.dim] += weight if (h >> 16) & 1 else -weight
            out.append(_normalise(vec))
        return out


class RemoteEmbedder:
    def __init__(self, settings: Settings) -> None:
        self.name = f"remote:{settings.embeddings_model}"
        self._settings = settings
        self._fallback = LocalHashEmbedder()

    def embed(self, texts: list[str]) -> list[list[float]]:
        s = self._settings
        try:
            resp = httpx.post(
                f"{s.embeddings_base_url}/embeddings",
                headers={"Authorization": f"Bearer {s.embeddings_api_key}"},
                json={"model": s.embeddings_model, "input": texts},
                timeout=s.llm_timeout_s,
            )
            resp.raise_for_status()
            data = sorted(resp.json()["data"], key=lambda d: d["index"])
            if len(data) != len(texts):
                raise ValueError("embedding count mismatch")
            return [_normalise([float(x) for x in d["embedding"]]) for d in data]
        except Exception as exc:
            log.warning("remote embeddings failed, using local: %s", exc)
            return self._fallback.embed(texts)


def get_embedder(settings: Settings) -> Embedder:
    return RemoteEmbedder(settings) if settings.embeddings_api_key else LocalHashEmbedder()
