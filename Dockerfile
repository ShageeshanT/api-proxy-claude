FROM node:20-slim

# Claude Code CLI needs git + ca-certs; jq makes the entrypoint robust.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally.
RUN npm install -g @anthropic-ai/claude-code@latest

WORKDIR /app

# Install JS deps first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

# Build the TypeScript.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Entrypoint writes Claude credentials from env, then runs the server.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV HOME=/home/claude
RUN mkdir -p /home/claude/.claude && chown -R node:node /home/claude /app
USER node

EXPOSE 3456
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server/standalone.js"]
