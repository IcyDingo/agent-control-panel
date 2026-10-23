# Build from the repository root:  docker build -f hub/Dockerfile -t agent-hub .
# The hub reads world.mjs (the shared rules) and release-keys.mjs (the keys a release must be signed by), and serves
# public/world.js (the page that draws a system).
FROM node:22-alpine
WORKDIR /app
COPY world.mjs ./world.mjs
COPY release-keys.mjs ./release-keys.mjs
COPY public/world.js ./public/world.js
COPY hub ./hub
# The hub runs as the image's unprivileged node user: the code stays root's and read-only to it, and the one place it
# writes is the database folder, which it owns (a new volume takes this folder's owner).
RUN mkdir /data && chown node:node /data
ENV HUB_DATA=/data
VOLUME /data
USER node
EXPOSE 4848
CMD ["node", "--no-warnings=ExperimentalWarning", "hub/server.mjs"]
