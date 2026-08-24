FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server ./server
COPY web ./web
COPY extension ./extension
COPY LICENSE ./LICENSE

RUN mkdir -p /data && chown -R node:node /app /data

USER node
ENV NODE_ENV=production \
    JOBDECK_HOST=0.0.0.0 \
    JOBDECK_PORT=43120 \
    JOBDECK_DATA_DIR=/data

EXPOSE 43120
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43120/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
