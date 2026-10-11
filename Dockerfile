FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; npm ci
COPY tsconfig.json ./
COPY server ./server
COPY tests ./tests
COPY ops ./ops
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 QR_DB_PATH=/data/qr.sqlite
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev && mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/ops ./ops
COPY --chown=node:node index.html app.js style.css ./
USER node
EXPOSE 4173
VOLUME /data
CMD ["node","dist/server/main.js"]
