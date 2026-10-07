# Waddle VM image — the single artifact Tinfoil measures.
# Phase 0 refines this (digest pinning, healthcheck, restart policy,
# non-root user, volume mounts); Phase 2 rebases onto the Playwright image.
FROM node:24-slim AS base
corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY server/package.json server/package.json
COPY sdk/package.json sdk/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /server/node_modules ./node_modules
COPY --from=deps /server/server/node_modules ./server/node_modules
COPY --from=deps /server/sdk/node_modules ./sdk/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json ./
COPY app vm
COPY sdk sdk
RUN pnpm --filter @waddle/vm build && pnpm --filter @waddle/sdk build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /server/sdk/dist ./sdk/dist
COPY --from=build /server/server/dist ./server/dist
COPY --from=build /server/node_modules ./node_modules
COPY --from=build /server/server/package.json ./server/package.json
COPY --from=build /server/sdk/package.json ./sdk/package.json
CMD ["node", "server/dist/index.js"]
