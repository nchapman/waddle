# The concierge — always-on, wake-only for now. Holds the scoped Tinfoil
# admin key; mounts the docker socket only for the docker (dev) backend.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY concierge/package.json ./
COPY concierge/dist ./dist
CMD ["node", "dist/index.js"]
