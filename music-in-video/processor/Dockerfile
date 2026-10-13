# The MS-007 Processor container (Cloudflare Containers). Built by Wrangler
# from the root wrangler config with the repository root as the build context
# (the root .dockerignore lets in only the files copied here). Node 20, no
# npm dependencies, no ffmpeg: the page uploads ready-decoded 16 kHz PCM.
FROM node:20-slim
WORKDIR /app
COPY music-in-video/package.json music-in-video/package.json
COPY music-in-video/public/music/fp.js music-in-video/public/music/body.js music-in-video/public/music/
COPY music-in-video/src/ music-in-video/src/
COPY music-in-video/processor/server.mjs music-in-video/processor/server.mjs
COPY clearance-check/public/lib.js clearance-check/public/lib.js
USER node
EXPOSE 8080
CMD ["node", "music-in-video/processor/server.mjs"]
