# syntax=docker/dockerfile:1
# ThiKha Translate — single image: Vite static build + Express + Python (PyMuPDF / Gemini)

# -----------------------------------------------------------------------------
# 1) Build frontend + bundle server
# -----------------------------------------------------------------------------
FROM node:22-bookworm AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# -----------------------------------------------------------------------------
# 2) Production runtime: Node + Python venv (same container = one pattern)
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# Python venv (avoids Debian PEP 668 / --break-system-packages issues)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements-docker.txt ./requirements-docker.txt
RUN pip install --no-cache-dir -r requirements-docker.txt

# Node production deps (esbuild output keeps deps external)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

COPY pdf_processor.py translate_pdf.py ./

# Server expects Pyidaungsu.ttf at cwd (repo uses lowercase filename)
COPY pyidaungsu.ttf ./Pyidaungsu.ttf

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.cjs"]
