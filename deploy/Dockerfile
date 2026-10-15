FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/sources/package.json packages/sources/
COPY packages/storage/package.json packages/storage/
COPY packages/reports/package.json packages/reports/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/ui/package.json apps/ui/
RUN --mount=type=secret,id=cloud_ca \
    if [ -f /run/secrets/cloud_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/cloud_ca npm ci --ignore-scripts --fetch-timeout=15000 --fetch-retries=0; else npm ci --ignore-scripts --fetch-timeout=15000 --fetch-retries=0; fi
FROM dependencies AS build
COPY . .
RUN npm run build
FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts
FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/packages ./packages
COPY --chown=node:node --from=build /app/apps ./apps
COPY --chown=node:node scripts/healthcheck.mjs ./scripts/healthcheck.mjs
RUN test -x /usr/bin/flock
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "apps/web/dist/main.js"]
