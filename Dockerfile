# Waddle server image — the single artifact Tinfoil measures.
FROM node:24-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/package.json
COPY sdk/package.json sdk/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY --from=deps /app/sdk/node_modules ./sdk/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json ./
COPY server server
COPY sdk sdk
RUN pnpm --filter @waddle/sdk build && pnpm --filter @waddle/server build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/sdk/dist ./sdk/dist
COPY --from=build /app/sdk/package.json ./sdk/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
