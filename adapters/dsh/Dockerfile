# DSH 接入围炉适配器。需要 SSH 客户端（兜底拉发财 Cookie / 自建隧道）。
FROM node:22-alpine

RUN apk add --no-cache openssh-client

WORKDIR /app
ENV NODE_ENV=production

COPY agent.mjs dsh-web-client.js dsh-cookie.js ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV AGENT_DATA_DIR=/app/data

CMD ["node", "--no-warnings", "agent.mjs"]
