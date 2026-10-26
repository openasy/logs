# syntax=docker/dockerfile:1

FROM node:26.12.1-trixie-slim AS build
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# VictoriaLogs for the platform being built, checked against the checksum pinned in the script (ADR 0027, 0035).
RUN node scripts/victorialogs.ts linux "${TARGETARCH:-amd64}" /app/vendor \
  && npm run build && npm prune --omit=dev && mkdir -p /out/data

# openssl makes the syslog certificate on first start; everything else is Node and VictoriaLogs. Node runs the
# TypeScript sources directly; only production dependencies are copied.
FROM node:26.12.1-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn*
WORKDIR /app
COPY --from=build /app/package.json /app/openapi.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/vendor/victoria-logs ./vendor/victoria-logs
COPY --from=build /app/dist/web ./dist/web
COPY --from=build /app/dist/docs ./dist/docs
COPY --from=build --chown=node:node /out/data /data
# SQLite and VictoriaLogs' storage live in /data, openssl's scratch files in /tmp (tmpfs in compose), so the root
# filesystem can be read-only (ADR 0022).
ENV NODE_ENV=production PORT=8080 LOGS_DATA=/data
VOLUME /data
# 8080 UI, API and ingest; 6514 syslog over TLS; 1514 plain syslog over TCP and UDP, for sources that allow it.
EXPOSE 8080 6514 1514 1514/udp
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/main.ts"]
