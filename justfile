set shell := ["bash", "-cu"]

# Install toolchain (mise) + dependencies
setup:
    mise install
    pnpm install

# Hot loop: vm (tsx watch) + client (vite), parallel
dev:
    pnpm dev

# Typecheck + build every package
check:
    pnpm check && pnpm build

# Compose variant (same image shape as production)
up:
    docker compose up --build

# Dev variant: local build + concierge wiring (see compose.dev.yaml)
up-dev:
    docker compose -f compose.yaml -f compose.dev.yaml up --build

# Host-side concierge for the dev E2E loop (memory-only, docker backend)
concierge:
    cd concierge && CONCIERGE_BACKEND=docker CONCIERGE_TOKEN=devsecret CONCIERGE_PORT=8091 pnpm dev

down:
    docker compose down
