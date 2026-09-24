# Dev-server image: Phase 1 runs Vite in watch mode behind docker compose.
# A production build would swap this for an nginx stage serving dist/.
FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY shared/package.json shared/
COPY gateway/package.json gateway/
COPY client/package.json client/
RUN npm install --workspaces --include-workspace-root

COPY shared shared
COPY client client

RUN npm run build -w shared

WORKDIR /app/client
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
