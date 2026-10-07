# Waddle server image — the single artifact Tinfoil measures.
# pnpm deploy flattens the workspace symlink farm into a self-contained
# production tree; stage-copied symlinks are how the last image broke.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY server/package.json server/package.json
COPY sdk/package.json sdk/package.json
RUN pnpm install --frozen-lockfile
COPY server server
COPY sdk sdk
RUN pnpm --filter @waddle/sdk build \
 && pnpm --filter @waddle/server build \
 && pnpm --filter @waddle/server deploy --prod /deploy

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /deploy ./
EXPOSE 8080
CMD ["node", "dist/index.js"]
