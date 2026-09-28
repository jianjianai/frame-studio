FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng libsndfile1 git && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir 'kokoro==0.9.4' 'misaki[zh]==0.9.4' fastapi uvicorn soundfile numpy
WORKDIR /opt/speech
COPY speech/ .
RUN python download.py
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
ARG REVISION=development
LABEL org.opencontainers.image.source="https://github.com/jianjianai/frame-studio" org.opencontainers.image.revision=$REVISION
EXPOSE 8000
CMD ["uvicorn","server:app","--host","0.0.0.0","--port","8000"]
