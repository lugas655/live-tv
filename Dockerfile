# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build React app
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files dulu (cache layer)
COPY package*.json ./

RUN npm ci --frozen-lockfile

# Copy source code
COPY . .

# Build production bundle
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Serve dengan Nginx
# ─────────────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Hapus config nginx default
RUN rm /etc/nginx/conf.d/default.conf

# Copy hasil build React ke nginx html
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy konfigurasi nginx kita
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
