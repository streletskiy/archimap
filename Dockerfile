FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv aria2 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

RUN python3 -m venv /opt/pyosm \
  && /opt/pyosm/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/pyosm/bin/pip install --no-cache-dir osmium

COPY . .
RUN mkdir -p /app/data/downloads /app/data/geofabrik

ENV NODE_ENV=production
ENV PYTHON_BIN=/opt/pyosm/bin/python
EXPOSE 3252

CMD ["node", "server.js"]
