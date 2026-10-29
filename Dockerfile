# 围炉主服务。数据全部落在 /app/data 卷里，镜像本身无状态。
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# 只拷运行所需：源码、前端静态资源、清单。测试与文档不进镜像。
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data \
    && chown -R node:node /app

USER node

ENV PORT=8099 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

VOLUME /app/data
EXPOSE 8099

CMD ["node", "--no-warnings", "src/server.js"]
