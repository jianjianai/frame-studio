# FRAME Studio: one container, all data in /data.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates openssl chromium fonts-noto-cjk fonts-noto-color-emoji tini python3 python3-venv iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Beat This! (beats and bars for preview_audio): CPU PyTorch in its own Python environment.
# No model is built into the image: the studio downloads the ones it needs into /data/models as
# it starts (FRAME_DOWNLOAD_MODELS), so a model host being down never breaks a build.
COPY server/beat-this/requirements.txt /opt/beat-this/requirements.txt
RUN python3 -m venv /opt/beat-this \
 && /opt/beat-this/bin/pip install --no-cache-dir -r /opt/beat-this/requirements.txt

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && git lfs install --system

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The agents' adapters carry small patches (patches/, pnpm patchedDependencies).
COPY patches ./patches
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod && chown -R node:node /app
# The commit built: deploy/publish.sh compares a running studio's with the one it publishes.
ARG FRAME_COMMIT=""
RUN printf '%s\n' "$FRAME_COMMIT" > /app/.commit && chown node:node /app/.commit

ENV FRAME_HOME=/data \
    FRAME_HOST=0.0.0.0 \
    FRAME_PORT=4310 \
    FRAME_BROWSER=/usr/bin/chromium \
    FRAME_BEAT_PYTHON=/opt/beat-this/bin/python \
    FRAME_DOWNLOAD_MODELS=1 \
    FRAME_AGENT_HOME=/data/home \
    HOME=/data/home
USER node
VOLUME /data
EXPOSE 4310
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/frame.mjs", "serve"]
