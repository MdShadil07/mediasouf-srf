# ─── Stage 1: Build dependencies ─────────────────────────────────────────────
# mediasoup builds native C++ bindings — use full build image
FROM node:22-bookworm-slim AS builder

# Install build tools for mediasoup native module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    cmake \
    ninja-build \
    pkg-config \
    libssl-dev \
    libsrtp2-dev \
    libasound2-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./

# Install all deps + rebuild native mediasoup worker
RUN npm ci --include=optional

# ─── Stage 2: Production image ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS production

# Runtime deps only (libssl for DTLS, libsrtp2 for SRTP)
RUN apt-get update && apt-get install -y \
    libssl3 \
    libsrtp2-1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --shell /bin/bash --create-home sfu

WORKDIR /app

# Copy built node_modules (with native binaries) + source
COPY --from=builder --chown=sfu:nodejs /app/node_modules ./node_modules
COPY --chown=sfu:nodejs . .

# Remove dev files
RUN rm -f .env .env.* && \
    rm -rf README.md

USER sfu

# ─── Port configuration ────────────────────────────────────────────────────────
# Port 3001: Socket.IO signaling (TCP/HTTP)
EXPOSE 3001

# UDP 10000-59999: mediasoup WebRTC media ports (50,000 ports = ~12,500 concurrent transports)
# PRODUCTION (Linux): always use --network=host — Docker NAT cannot map 50k ports efficiently:
#   docker run --network=host --env-file .env.production cognitospeak-sfu
# LOCAL DEV ONLY (macOS/Windows, limited range):
#   docker run -p 10000-10200:10000-10200/udp -p 3001:3001 cognitospeak-sfu
EXPOSE 10000-59999/udp

# ─── Health check ─────────────────────────────────────────────────────────────
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/ping').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# ─── Start ────────────────────────────────────────────────────────────────────
CMD ["node", "--env-file=.env.production", "server.js"]
