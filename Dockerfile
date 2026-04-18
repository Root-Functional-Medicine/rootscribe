# --- Build stage ---
FROM node:20-slim AS build

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY web/ web/

RUN pnpm install --frozen-lockfile
RUN pnpm build

# Prune dev dependencies
RUN pnpm prune --prod

# --- Runtime stage ---
FROM node:20-slim

RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/shared/dist/ shared/dist/
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/node_modules/ shared/node_modules/
COPY --from=build /app/server/dist/ server/dist/
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules/ server/node_modules/
COPY --from=build /app/web/dist/ web/dist/

VOLUME ["/data/config", "/data/recordings"]

ENV ROOTSCRIBE_CONFIG_DIR=/data/config
ENV NODE_ENV=production

EXPOSE 44471

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/dist/index.js"]
