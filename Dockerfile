# 独立模式镜像：一个容器 = 一个能跑的 QQ 机器人（不需要 DeepSeek Harness）
#
#   docker build -t qqbot .
#   docker run -d --name qqbot --restart always -p 9999:9999 \
#     -e QQ_BOT_APP_ID=xxx -e QQ_BOT_APP_SECRET=yyy \
#     -v qqbot-data:/data/qqbot qqbot
#
# 代码在 /app，数据（配置、插件、历史、账号）在卷 /data/qqbot —— 两者分离，
# 所以升级镜像不会丢配置。
#
# 端口：容器内固定 9999，宿主机想用别的端口只需改 -p 的左侧，例如 -p 18000:9999；
#       也可以用 QQBOT_PORT 环境变量改容器内端口（同时改 -p 右侧）。
#
# 控制台出厂账号：harness / harness，首次登录强制修改。
FROM node:22-alpine

ENV NODE_ENV=production \
    QQBOT_HOME=/data/qqbot \
    QQBOT_CONSOLE_ENTRY=/app/dashboard/server.js

WORKDIR /app

# 零依赖：纯 Node 内置模块，没有 npm install 这一步
COPY qqbot-core/ ./qqbot-core/
COPY dashboard/ ./dashboard/
COPY shared/ ./shared/
COPY standalone/ ./standalone/
COPY scripts/ ./scripts/

# 官方 node 镜像里已经有 uid/gid 1000 的 node 用户，直接复用（自建会因 GID 冲突失败）
RUN mkdir -p /data/qqbot/runtime /data/qqbot/plugins /data/qqbot/runtime/media \
    && chown -R node:node /data/qqbot /app

USER node

VOLUME ["/data/qqbot"]
EXPOSE 9999

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9999/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["node", "standalone/server.js"]
CMD ["--home=/data/qqbot", "--port=9999"]
