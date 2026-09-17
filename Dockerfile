# =============================================================================
# uride-backend — NestJS API, self-contained production build (npm workspaces).
# This folder is standalone: build with the folder as context.
#   docker build -t uride-backend ./backend        (from repo root)
#   docker build -t uride-backend .                (from inside backend/)
# =============================================================================

# ---- Stage 1: deps (cached on manifests) ----
FROM node:22-alpine AS deps
WORKDIR /app

# Manifests + vendored package manifests first, so installs cache across code edits.
COPY package.json .npmrc ./
COPY packages ./packages

RUN npm install --include=dev

# ---- Stage 2: build ----
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
COPY prisma ./prisma
COPY scripts ./scripts

# Generate the Prisma client BEFORE compiling.
#
# Ordering is load-bearing, not cosmetic: src imports types from '@prisma/client'
# (UserRole, Ride, DriverProfile, ...), and those types do not exist until
# `prisma generate` has run. Building first fails type-checking outright.
RUN npx prisma generate

# Build vendored libs (types, validation) then the API.
RUN npm run build:standalone

# ---- Stage 3: runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Bring over only what we need to run. @uride/* resolve from node_modules -> vendored dist.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

# Run as non-root.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1

CMD ["node", "dist/main.js"]
