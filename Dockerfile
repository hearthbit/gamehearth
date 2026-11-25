FROM node:22-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/devtool/package.json packages/devtool/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY fixtures/mau-mau/package.json fixtures/mau-mau/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build --workspace=packages/devtool --workspace=packages/server --workspace=packages/client --if-present --silent \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf fixtures

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    CLIENT_DIR=/app/packages/client/dist
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/main.js"]
