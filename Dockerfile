FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && mkdir -p /home/node/.config/ontoplano-chat /home/node/.local/share/ontoplano-chat && chown -R node:node /home/node/.config /home/node/.local
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY AGENT.md ./AGENT.md
COPY web ./web
USER node
EXPOSE 1497
CMD ["node", "bin/ontoplano-chat.mjs", "serve"]
