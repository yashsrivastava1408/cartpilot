import os

# Tests must never reach a real LLM, whatever is in the developer's shell or .env.
for key in ("GROQ_API_KEY", "ANTHROPIC_API_KEY", "JEV_API_KEY", "OPENROUTER_API_KEY", "EMBEDDINGS_API_KEY"):
    os.environ[key] = ""
os.environ["CARTPILOT_PARSE_PROVIDER"] = "rules"

import pytest
from fastapi.testclient import TestClient

from cartpilot.main import app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)
