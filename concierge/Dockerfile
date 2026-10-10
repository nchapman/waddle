# Waddle concierge image — the always-on, dumb lifecycle timer.
# Tiny by design: the measured surface is one Fastify service + the tinfoil
# CLI (deploy/stop/list verbs, org-scoped by the injected admin key).
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# Only the concierge + sdk are installed here: drop the absent importers
# (client with its out-of-workspace betterbase link, plus server) so
# --frozen-lockfile validates against what actually exists. The sdk stays
# — the concierge imports the wire types from it.
RUN awk '/^  (client|server):/ { skip=1 } /^  [A-Za-z.]+:/ && !/^  (client|server):/ { skip=0 } /^[A-Za-z]/ { skip=0 } !skip' pnpm-lock.yaml > lock.tmp && mv lock.tmp pnpm-lock.yaml
COPY concierge/package.json concierge/package.json
COPY sdk/package.json sdk/package.json
RUN pnpm install --frozen-lockfile
COPY concierge concierge
COPY sdk sdk
RUN pnpm --filter @waddle/sdk build \
 && pnpm --filter @waddle/concierge build \
 && pnpm --filter @waddle/concierge deploy --prod /deploy

FROM node:24-slim
ENV NODE_ENV=production
# System CA bundle: the tinfoil CLI is Go and reads /etc/ssl/certs — slim
# ships it empty (Node bundles its own roots, Go does not).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The platform pen: pinned CLI (0.19.0) for container deploy/stop/list.
ADD https://github.com/tinfoilsh/tinfoil-cli/releases/download/v0.19.0/tinfoil-cli_0.19.0_linux_amd64.tar.gz /tmp/tinfoil.tar.gz
RUN tar -xzf /tmp/tinfoil.tar.gz -C /usr/local/bin tinfoil \
 && rm /tmp/tinfoil.tar.gz \
 && tinfoil --version
WORKDIR /app
COPY --from=build /deploy ./
EXPOSE 8081
CMD ["node", "dist/index.js"]
