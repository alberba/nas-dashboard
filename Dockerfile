FROM node:26-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_APP_DOMAIN=example.com
ENV NEXT_PUBLIC_APP_DOMAIN=$NEXT_PUBLIC_APP_DOMAIN
ENV NEXT_TELEMETRY_DISABLED=1
RUN BETTER_AUTH_SECRET=build-placeholder-never-used-at-runtime-32 pnpm build

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@12.15.0
COPY --from=build --chown=node:node /app .
USER node
EXPOSE 3000
CMD ["pnpm", "start", "--hostname", "0.0.0.0"]
