# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------- build
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
COPY src ./src
# RUN npx prisma generate && npm run build
ARG DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shopping?schema=public"
RUN DATABASE_URL="$DATABASE_URL" npx prisma generate && npm run build

# ---------------------------------------------------------------- migrações (prisma migrate deploy)
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p storage/uploads && chown -R node:node storage
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
