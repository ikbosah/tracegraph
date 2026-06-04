# TraceGraph Team Server — Multi-stage Docker build
#
# Stage 1 (builder): install deps + compile TypeScript
# Stage 2 (runtime): minimal Node.js image, production deps only

# ── Stage 1: Build ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace files needed for the build
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/team-server/package.json  packages/team-server/

# Install dependencies
RUN pnpm install --frozen-lockfile --filter @tracegraph/team-server...

# Copy source
COPY packages/shared-types/src packages/shared-types/src/
COPY packages/team-server/src  packages/team-server/src/
COPY packages/team-server/tsconfig.json packages/team-server/

# Build
WORKDIR /app/packages/team-server
RUN pnpm run build

# ── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Install pnpm for production install
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy only the files needed to run
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/shared-types/package.json packages/shared-types/
COPY --from=builder /app/packages/team-server/package.json  packages/team-server/
COPY --from=builder /app/packages/team-server/dist          packages/team-server/dist/

# Install production deps only
RUN pnpm install --frozen-lockfile --prod --filter @tracegraph/team-server...

# Data directory (mounted as volume in production)
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

ENV TRACEGRAPH_DATA_DIR=/data \
    NODE_ENV=production

CMD ["node", "/app/packages/team-server/dist/index.js"]
