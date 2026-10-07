# Waddle VM image — the single artifact Tinfoil measures.
# Phase 0 refines this (digest pinning, healthcheck, restart policy,
# non-root user, volume mounts); Phase 2 rebases onto the Playwright image.
FROM node:24-slim AS base
corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY vm/package.json vm/package.json
COPY sdk/package.json sdk/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/vm/node_modules ./vm/node_modules
COPY --from=deps /app/sdk/node_modules ./sdk/node_modules
COPY tsconfig.base.json pnpm-workspace.yaml package.json ./
COPY vm vm
COPY sdk sdk
RUN pnpm --filter @waddle/vm build && pnpm --filter @waddle/sdk build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app/sdk/dist ./sdk/dist
COPY --from=build /app/vm/dist ./vm/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vm/package.json ./vm/package.json
COPY --from=build /app/sdk/package.json ./sdk/package.json
CMD ["node", "vm/dist/index.js"]
