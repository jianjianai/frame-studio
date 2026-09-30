# syntax=docker/dockerfile:1.14
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs gh ffmpeg chromium fonts-noto-cjk ca-certificates curl tini && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install -g pnpm@12.4.2 @openai/codex@0.158.0 @anthropic-ai/claude-code@2.1.283
WORKDIR /opt/frame
# Fetch from the lockfile so a version/script edit does not invalidate downloads.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY package.json ./
RUN pnpm install --offline --frozen-lockfile
# Worktrees copied from private AgentDock volumes may have 0700/0600 modes.
# Normalize source permissions during COPY; do not rewrite cached node_modules.
COPY --chmod=u=rwX,go=rX . .
RUN pnpm exec vite build --config studio/vite.config.mjs
ENV NODE_ENV=production FRAME_BROWSER=/usr/bin/chromium FRAME_ROLE=api HOME=/tmp/frame-home
ARG REVISION=development
ENV FRAME_REVISION=$REVISION
LABEL org.opencontainers.image.source="https://github.com/jianjianai/frame-studio" org.opencontainers.image.revision=$REVISION
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
USER 1000:1000
CMD ["node","server/app.mjs"]
