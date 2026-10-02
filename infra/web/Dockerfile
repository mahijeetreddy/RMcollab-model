# The public front door in production (docker-compose.prod.yml): the client,
# built once into static files, served by Caddy - which also gets and renews
# the HTTPS certificate, and proxies the API, the socket and signed file links
# to the gateway replicas. Build context is the repo root.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY client/package.json client/
RUN npm ci --workspaces --include-workspace-root
COPY shared shared
COPY client client
# "" means "this page's own origin" (client/src/api/client.ts): the gateway is
# reached through the same Caddy that serves the page.
ENV VITE_GATEWAY_HTTP="" \
    VITE_GATEWAY_WS=""
# Baked in at build time, as Vite does with every VITE_ variable. A browser DSN
# is public by design: it can only send error reports.
ARG VITE_SENTRY_DSN=""
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_ENVIRONMENT=production
RUN npm run build -w shared && npm run build -w client

FROM caddy:2-alpine
COPY infra/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/client/dist /srv
