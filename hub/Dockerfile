# Build from the repository root:  docker build -f hub/Dockerfile -t agent-hub .
# The hub reads world.mjs (the shared rules) and serves public/world.js (the page that draws a system).
FROM node:22-alpine
WORKDIR /app
COPY world.mjs ./world.mjs
COPY public/world.js ./public/world.js
COPY hub ./hub
ENV HUB_DATA=/data
VOLUME /data
EXPOSE 4848
CMD ["node", "--no-warnings=ExperimentalWarning", "hub/server.mjs"]
