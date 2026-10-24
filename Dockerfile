FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY distiller/package.json distiller/package.json
COPY hooks/package.json hooks/package.json
COPY extension/package.json extension/package.json
COPY web/package.json web/package.json
COPY bench/package.json bench/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web
ENV NODE_ENV=production CANON_DATA_DIR=/app/data
CMD ["node", "scripts/preview.mjs"]
