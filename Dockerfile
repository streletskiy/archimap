FROM debian:bookworm-slim AS tippecanoe-builder

WORKDIR /tmp/tippecanoe

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    build-essential \
    git \
    pkg-config \
    zlib1g-dev \
    libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/felt/tippecanoe.git . \
  && make -j"$(nproc)" \
  && strip tippecanoe tile-join

FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    ca-certificates \
    libsqlite3-0 \
    zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tippecanoe-builder /tmp/tippecanoe/tippecanoe /usr/local/bin/tippecanoe
COPY --from=tippecanoe-builder /tmp/tippecanoe/tile-join /usr/local/bin/tile-join

COPY package*.json ./
RUN npm ci --omit=dev

RUN python3 -m venv /opt/pyosm \
  && /opt/pyosm/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/pyosm/bin/pip install --no-cache-dir quackosm duckdb

COPY . .
RUN mkdir -p /app/data/quackosm

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/pyosm/bin/python
EXPOSE 3252

CMD ["node", "server.js"]

