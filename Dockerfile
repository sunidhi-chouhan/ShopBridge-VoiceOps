# Cloud Run image: build the SPA, then run the API with tsx (same as `npm start`).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY server ./server
COPY shared ./shared
COPY web/public ./web/public
COPY --from=build /app/dist/web ./dist/web
USER node
EXPOSE 8080
CMD ["npx", "tsx", "server/index.ts"]
