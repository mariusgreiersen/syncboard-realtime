# syntax=docker/dockerfile:1.7
# Multi-stage build for the SyncBoard server (Node.js) and client (static files on nginx).

ARG NODE_IMAGE=node:24-alpine

# --- dependencies (all workspaces, including dev tooling for the build) ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --no-audit --no-fund

# --- build ------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/client apps/client
RUN npm run build -w @syncboard/server && npm run build -w @syncboard/client

# --- production dependencies of the server only ---------------------------------------
FROM ${NODE_IMAGE} AS server-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
RUN npm ci --omit=dev --no-audit --no-fund -w @syncboard/server

# --- server runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./dist
COPY apps/server/drizzle ./drizzle
COPY docker/server-entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 3001
# Migrate, optionally seed the demo data, then replace the shell with the server (receives SIGTERM).
CMD ["sh", "./entrypoint.sh"]

# --- client runtime ---------------------------------------------------------------
FROM nginx:1.28-alpine AS client
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
EXPOSE 80
