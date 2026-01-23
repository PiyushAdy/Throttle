# Multi-stage build for the demo app (Redis + app start together via docker-compose.yml).
FROM node:20-alpine AS build
WORKDIR /app

# Install with the workspace graph intact so @throttle/core links locally.
COPY package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/load-test/package.json packages/load-test/
COPY apps/demo/package.json apps/demo/
RUN npm install --no-audit --no-fund

COPY packages/core packages/core
COPY apps/demo apps/demo
RUN npm run build --workspace @throttle/core && npm run build --workspace @throttle/demo

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/apps/demo/dist apps/demo/dist
COPY --from=build /app/apps/demo/package.json apps/demo/package.json
EXPOSE 3000
CMD ["node", "apps/demo/dist/server.js"]
