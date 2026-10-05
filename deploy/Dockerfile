# FRAME Studio: one container, all data in /data.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates chromium fonts-noto-cjk fonts-noto-color-emoji tini \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && git lfs install --system

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod && chown -R node:node /app

ENV FRAME_HOME=/data \
    FRAME_HOST=0.0.0.0 \
    FRAME_PORT=4310 \
    FRAME_BROWSER=/usr/bin/chromium \
    FRAME_AGENT_HOME=/data/home \
    HOME=/data/home
USER node
VOLUME /data
EXPOSE 4310
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/frame.mjs", "serve"]
