FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json eslint.config.mjs vitest.config.ts ./
RUN npm install --no-audit --no-fund
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S hsi && adduser -S -G hsi hsi && mkdir -p /data && chown -R hsi:hsi /data
COPY --from=build --chown=hsi:hsi /app/node_modules ./node_modules
COPY --from=build --chown=hsi:hsi /app/dist ./dist
COPY --from=build --chown=hsi:hsi /app/package.json ./
USER hsi
EXPOSE 8080 9901
CMD ["node","dist/web/server.mjs"]
