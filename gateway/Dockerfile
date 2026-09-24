# Build context is the repo root — the gateway is an npm workspace that depends
# on @rmcollab/shared, so both need to be present for install and build.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY client/package.json client/
RUN npm install --workspaces --include-workspace-root

COPY shared shared
COPY gateway gateway

RUN npm run build -w shared && npm run build -w gateway

# schema.sql is data, not TypeScript, so tsc doesn't carry it into dist.
RUN mkdir -p gateway/dist/db && cp gateway/src/db/schema.sql gateway/dist/db/schema.sql

WORKDIR /app/gateway
EXPOSE 4000
CMD ["node", "dist/index.js"]
