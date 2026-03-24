FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Production image ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Install only production deps
COPY package*.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

# Run DB migration then start app
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
