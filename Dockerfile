# A named build context can override this empty package cache for offline recovery.
FROM scratch AS factory-cli-cache
COPY package.json /placeholder.json

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY distiller/package.json distiller/package.json
COPY hooks/package.json hooks/package.json
COPY extension/package.json extension/package.json
COPY web/package.json web/package.json
COPY bench/package.json bench/package.json
# Optional verified public CLI tarball can seed the cache on unreliable networks.
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,from=factory-cli-cache,target=/provider-cache,readonly \
    if [ -f /provider-cache/factory-cli.tgz ]; then npm cache add /provider-cache/factory-cli.tgz; fi \
    && npm ci --prefer-offline --no-audit --no-fund \
    && node_modules/.bin/droid --version
COPY . .
RUN npm run build -w web
ENV NODE_ENV=production CANON_DATA_DIR=/app/data
CMD ["node", "scripts/preview.mjs"]
