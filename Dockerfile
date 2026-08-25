FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY server/tsconfig.json server/tsconfig.json
COPY web/tsconfig.json web/tsconfig.json
COPY vite.config.ts vite.config.ts
COPY server/src server/src
COPY web web

RUN npm run build

ENV PORT=3210
ENV HOST=0.0.0.0
EXPOSE 3210

VOLUME ["/app/data"]

CMD ["node", "server/dist/index.js"]
