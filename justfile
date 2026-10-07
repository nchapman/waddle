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

down:
    docker compose down
