# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------------------------
# deps: full dependency set. A compile toolchain is present in case better-sqlite3's prebuilt
# binary doesn't match this platform and it has to build the native addon from source.
# ---------------------------------------------------------------------------------------------
FROM node:20-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ---------------------------------------------------------------------------------------------
# build: deps + source -> .next/standalone (server.js) with better-sqlite3 traced in.
# ---------------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------------------------
# test: deps + source. Target used by `docker compose run --rm test` (in-memory DB, no server).
# ---------------------------------------------------------------------------------------------
FROM deps AS test
WORKDIR /app
COPY . .
ENV NODE_ENV=test
CMD ["npm", "test"]

# ---------------------------------------------------------------------------------------------
# runtime: slim, non-root, standalone output only. The native addon + its runtime deps come
# along inside the traced standalone node_modules.
# ---------------------------------------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --system --gid 1001 edemand \
  && useradd --system --uid 1001 --gid edemand edemand
WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN mkdir -p /app/data && chown -R edemand:edemand /app
USER edemand
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
