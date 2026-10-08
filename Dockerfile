# Waddle server image — the single artifact Tinfoil measures.
# pnpm deploy flattens the workspace symlink farm into a self-contained
# production tree; stage-copied symlinks are how the last image broke.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# The image builds server+sdk only; the client's betterbase source link
# (outside this workspace) would break pnpm deploy. Strip it from the
# lockfile — the client importer is not installed here.
RUN sed -i '/betterbase/d' pnpm-lock.yaml
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
# Writable state (anonymous volume) survives read-only rootfs enforcement.
VOLUME /tmp/waddle-data
EXPOSE 8080
CMD ["node", "dist/index.js"]
