PY := backend/.venv/bin

.PHONY: setup run test e2e check icons

setup:            ## create the virtualenv and install everything
	python3.11 -m venv backend/.venv
	$(PY)/pip install -q -r backend/requirements-dev.txt
	cd e2e && npm install && npx playwright install chromium

run:              ## start the API, web app and mock stores on http://localhost:8000
	cd backend && .venv/bin/uvicorn cartpilot.main:app --port 8000

test:             ## backend tests
	cd backend && .venv/bin/python -m pytest -q

e2e:              ## browser tests (web demo + real extension)
	cd e2e && npx playwright test

check: test e2e   ## everything

icons:            ## regenerate extension icons
	python3 scripts/make_icons.py
