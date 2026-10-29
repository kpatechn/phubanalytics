# The analytics dashboard as one container: the API, serving the built web app from the same
# origin (WEB_ROOT). Built for linux/arm64 (Fargate Graviton) by scripts/push-dashboard-image.sh.
# Configuration comes from the environment at run time (apps/api/.env.example); none is baked in.

FROM public.ecr.aws/docker/library/node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build -w @phub/api && npm run build -w @phub/web

# Production dependencies of the API only.
FROM public.ecr.aws/docker/library/node:24-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund --omit=dev --workspace @phub/api

FROM public.ecr.aws/docker/library/node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEB_ROOT=/app/web
WORKDIR /app
COPY --from=deps /src/node_modules node_modules
COPY apps/api/package.json apps/api/
COPY --from=build /src/apps/api/dist apps/api/dist
COPY --from=build /src/apps/web/dist/web/browser web
USER node
EXPOSE 3000
WORKDIR /app/apps/api
CMD ["node", "dist/server.js"]
