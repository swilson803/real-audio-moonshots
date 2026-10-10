# The MS-007 Processor container (Cloudflare Containers, standard-4: 4 vCPU,
# 12 GiB). Built by Wrangler from the root wrangler config with the
# repository root as the build context (the root .dockerignore lets in only
# the files copied here).
# Node 20 runs the processor (no npm dependencies, no ffmpeg: the page
# uploads ready-decoded 16 kHz PCM); Python 3.13 runs the music/speech
# separation (Demucs, processor/separate.py) with the experiment's exact
# package versions and the htdemucs weights baked in, so a job never
# downloads anything.
FROM node:20-slim AS node

FROM python:3.13-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY music-in-video/processor/requirements.txt /opt/separation/requirements.txt
RUN python -m venv /opt/separation/venv \
 && /opt/separation/venv/bin/pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r /opt/separation/requirements.txt
ENV HF_HOME=/opt/separation/models SEPARATION_PYTHON=/opt/separation/venv/bin/python SEPARATION_THREADS=4
RUN /opt/separation/venv/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')" \
 && chmod -R a+rX /opt/separation
ENV HF_HUB_OFFLINE=1
WORKDIR /app
COPY music-in-video/package.json music-in-video/package.json
COPY music-in-video/public/music/fp.js music-in-video/public/music/body.js music-in-video/public/music/
COPY music-in-video/src/ music-in-video/src/
COPY music-in-video/processor/server.mjs music-in-video/processor/separate.py music-in-video/processor/
COPY clearance-check/public/lib.js clearance-check/public/lib.js
USER nobody
EXPOSE 8080
CMD ["node", "music-in-video/processor/server.mjs"]
