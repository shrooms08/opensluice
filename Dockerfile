# syntax=docker/dockerfile:1

# ---- stage 1: build workspaces + web bundle --------------------------------
FROM node:20-bookworm AS build
WORKDIR /app

# Manifests first so dependency layers cache across source changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/adapter/package.json packages/adapter/
COPY packages/gateway/package.json packages/gateway/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN npm run build
# Drop dev deps (vite, vitest, ...) — the runtime keeps fastify, sqlite, tsx.
RUN npm prune --omit=dev

# ---- stage 2: slim runtime --------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/adapter ./packages/adapter
COPY --from=build /app/packages/gateway ./packages/gateway
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Kept in the runtime image so `npm run seed:demo` works via docker compose
# exec; the script has no imports, it just talks HTTP to a running gateway.
COPY scripts ./scripts

# SQLite lives on a volume; owned by the unprivileged node user.
RUN mkdir -p /data && chown node:node /data
USER node
ENV OPENSLUICE_DB_PATH=/data/opensluice.db \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "packages/gateway/src/main.ts"]
