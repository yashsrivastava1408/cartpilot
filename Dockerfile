# Backend + web demo + mock stores in one image.  docker build -t cartpilot . && docker run -p 8000:8000 cartpilot
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 CARTPILOT_EXTENSION_DIR=/app/extension
WORKDIR /app/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/cartpilot ./cartpilot
COPY extension /app/extension
RUN useradd --create-home cartpilot
USER cartpilot
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["uvicorn", "cartpilot.main:app", "--host", "0.0.0.0", "--port", "8000"]
