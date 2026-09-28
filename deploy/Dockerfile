FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git git-lfs ffmpeg chromium fonts-noto-cjk ca-certificates curl tini && rm -rf /var/lib/apt/lists/*
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install -g pnpm@12.4.2 @openai/codex@0.158.0 @anthropic-ai/claude-code@2.1.283
WORKDIR /opt/frame
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm exec vite build --config studio/vite.config.mjs
ENV NODE_ENV=production FRAME_BROWSER=/usr/bin/chromium
ARG REVISION=development
ENV FRAME_REVISION=$REVISION
LABEL org.opencontainers.image.source="https://github.com/jianjianai/frame-studio" org.opencontainers.image.revision=$REVISION
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server/app.mjs"]
