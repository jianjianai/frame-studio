# FRAME Studio: one container, all data in /data.
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git git-lfs ca-certificates chromium fonts-noto-cjk fonts-noto-color-emoji tini python3 python3-venv iproute2 \
 && rm -rf /var/lib/apt/lists/*

# Beat This! (beats and bars for preview_audio): CPU PyTorch in its own Python environment,
# with the model downloaded at build time so analysis never waits for (or needs) the network.
COPY server/beat-this/requirements.txt /opt/beat-this/requirements.txt
RUN python3 -m venv /opt/beat-this \
 && /opt/beat-this/bin/pip install --no-cache-dir -r /opt/beat-this/requirements.txt \
 && TORCH_HOME=/opt/beat-this/torch /opt/beat-this/bin/python -c "from beat_this.inference import load_checkpoint; load_checkpoint('final0')"

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && git lfs install --system

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# The agents' adapters carry small patches (patches/, pnpm patchedDependencies).
COPY patches ./patches
RUN pnpm install --frozen-lockfile
# Voice input in the chat: the speech recognition model and the pause detector come with the
# image, so the microphone works without a download (models.mjs says which).
COPY server/speech/models.mjs server/speech/download.mjs server/speech/bundle.mjs ./server/speech/
RUN node server/speech/bundle.mjs /opt/frame-models/speech
COPY . .
RUN pnpm build && pnpm prune --prod && chown -R node:node /app

ENV FRAME_HOME=/data \
    FRAME_HOST=0.0.0.0 \
    FRAME_PORT=4310 \
    FRAME_BROWSER=/usr/bin/chromium \
    FRAME_BEAT_PYTHON=/opt/beat-this/bin/python \
    TORCH_HOME=/opt/beat-this/torch \
    FRAME_SPEECH_MODELS=/opt/frame-models/speech \
    FRAME_AGENT_HOME=/data/home \
    HOME=/data/home
USER node
VOLUME /data
EXPOSE 4310
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/frame.mjs", "serve"]
