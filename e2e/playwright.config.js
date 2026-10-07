// Browser tests. They start the backend themselves (or reuse one already on :8000)
// and run fully offline against the mock stores.
const { defineConfig } = require("@playwright/test");
const path = require("path");

const backend = path.resolve(__dirname, "..", "backend");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:8000", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: {
    command: `${path.join(backend, ".venv", "bin", "uvicorn")} cartpilot.main:app --port 8000 --log-level warning`,
    cwd: backend,
    url: "http://localhost:8000/healthz",
    reuseExistingServer: true,
    timeout: 30_000,
    // Keep the run offline and deterministic whatever keys are in the developer's shell.
    env: { CARTPILOT_LOG_LEVEL: "WARNING", CARTPILOT_PARSE_PROVIDER: "rules", GROQ_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", JEV_API_KEY: "", EMBEDDINGS_API_KEY: "" },
  },
});
