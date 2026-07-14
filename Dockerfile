# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# Install pnpm
RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests first (better layer caching)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy all package manifests (needed for workspace resolution)
COPY lib/db/package.json              lib/db/
COPY lib/api-zod/package.json         lib/api-zod/
COPY lib/api-spec/package.json        lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY scripts/package.json             scripts/
COPY artifacts/api-server/package.json artifacts/api-server/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY lib/         lib/
COPY artifacts/api-server/ artifacts/api-server/

# Build shared libs then the API server
RUN pnpm run typecheck:libs
RUN pnpm --filter @workspace/api-server run build

# ─── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests (pnpm needs them for symlink resolution)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json              lib/db/
COPY lib/api-zod/package.json         lib/api-zod/
COPY lib/api-spec/package.json        lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY scripts/package.json             scripts/
COPY artifacts/api-server/package.json artifacts/api-server/

# Production-only install (no devDeps)
RUN pnpm install --frozen-lockfile --prod

# Copy the compiled bundle from the build stage
COPY --from=builder /app/artifacts/api-server/dist/ artifacts/api-server/dist/

# Stripe is bundled by esbuild. googleapis is external — copy node_modules.
# (googleapis is in the external list in build.mjs so it is NOT bundled)
COPY --from=builder /app/node_modules/ node_modules/

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
