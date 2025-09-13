FROM node:22 AS build

RUN npm i -g corepack@latest
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:22 AS deps

RUN npm i -g corepack@latest
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod

FROM public.ecr.aws/lambda/nodejs:22

WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist/index.mjs ./
ENV NODE_ENV production
CMD ["index.handler"]
