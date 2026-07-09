# syntax=docker/dockerfile:1

# ---------- Stage 1: install production dependencies ----------
FROM node:22-alpine AS deps
WORKDIR /app

# libSQL (@libsql/client) uses a native binding → ships prebuilt, but provide a
# minimal toolchain just in case a rebuild is needed.
RUN apk add --no-cache python3 make g++

# Copy the manifest first so the dependency layer cache stays warm.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- Stage 2: runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# Run as a non-root user (the node:alpine image already has a "node" user).
ENV NODE_ENV=production \
    PORT=3040 \
    HOST=0.0.0.0

# Take the clean node_modules from the deps stage (including the libSQL binding).
COPY --from=deps /app/node_modules ./node_modules

# Copy the application source (see .dockerignore for what's excluded).
COPY package.json server.js ./
COPY src ./src
COPY app ./app
COPY assets ./assets
COPY index.html ./

# Data directory for SQLite (mounted as a volume so it persists).
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# Drop privileges to the non-root user.
USER node

EXPOSE 3040

# Container health-check: hit the /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3040)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
