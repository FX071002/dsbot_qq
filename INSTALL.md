# 部署与升级

两种部署方式，任选其一：

- **镜像**（推荐）：不需要 Node、不需要 clone，一条 `docker run`。
- **源码**：`git clone` 后用 Node 直接跑（独立模式），或装进已有的 DeepSeek Harness。

## 一、用镜像部署（最快）

```bash
docker run -d --name qqbot --restart always -p 9999:9999 \
  -e TZ=Asia/Shanghai \
  -v qqbot-data:/data/qqbot \
  ghcr.io/fx071002/dsbot_qq:latest
```

- **端口**：容器内固定 `9999`；宿主机想用别的端口改 `-p` 左侧即可，例如 `-p 18000:9999`。
  若确实要改容器内端口：`-e QQBOT_PORT=18000 -p 18000:18000`。
- **数据**：全部在卷 `qqbot-data`（映射到容器内 `/data/qqbot`）——配置、插件、对话历史、控制台账号。
  **升级镜像不会丢配置。**
- **日志**：`docker logs -f qqbot`。

也可以把仓库里的 `docker-compose.yml` 和 `.env` 放一起，`docker compose up -d`。

### 首次使用

1. 打开 `http://<你的地址>:9999/`；
2. 用出厂账号 **`harness` / `harness`** 登录（登录框下方有提示）；
3. 按提示**强制修改**账号密码（≥6 位，含大小写字母与数字），改完用新账号重新登录；
4. 到「连接」页填 QQ 的 AppID / AppSecret，保存后桥接自动重连；
5. 到「模型」页接入一个服务商并选好对话模型。

## 二、源码部署

```bash
git clone https://github.com/FX071002/dsbot_qq.git
cd dsbot_qq
QQBOT_HOME="$PWD" ./standalone/start.sh
```

不带凭据也能起：进程会先跑起来并提示「尚未配置 QQ 凭据」，等你在控制台「连接」页填好就自动连上。
凭据也可以走环境变量或 `standalone/config.json`（模板见 `standalone/config.json.example`）：

```bash
QQ_BOT_APP_ID=你的AppID QQ_BOT_APP_SECRET=你的AppSecret ./standalone/start.sh
```

优先级：**控制台「连接」页 > 环境变量 > `standalone/config.json`**。

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `QQBOT_HOME` | 仓库目录 | 数据目录（runtime/plugins/日志/账号） |
| `QQBOT_PORT` | `9999` | 控制台与服务的端口 |
| `QQ_BOT_APP_ID` / `QQ_BOT_APP_SECRET` | 空 | QQ 凭据 |
| `QQBOT_AUTH_USER` / `QQBOT_AUTH_PASSWORD` | `harness` / `harness` | 预设控制台初始账号（仍会要求首次登录后修改） |

## 三、装进 DeepSeek Harness（可选）

只有想用 Harness 的工具链（联网 / 文件 / 命令 / 子代理）与会话审计时才需要：

```bash
export QQ_BOT_APP_ID=你的AppID
export QQ_BOT_APP_SECRET=你的AppSecret
./install.sh
```

它会把 `qqbot-core/` 注册进 Harness 的 profile，并把控制台挂到 Harness Web 入口下的 `/qqbot/`。
详见 [docs/harness.md](docs/harness.md)。

## 四、验证

```bash
# 控制台在跑
curl -s http://127.0.0.1:9999/healthz          # {"ok":true,...}

# 桥接状态（unconfigured = 还没填凭据；online = 已连上 QQ）
cat "$QQBOT_HOME/qqbot-status.json" | head -12

# 本地挂载自测（只有装了 Harness 插件才有意义，用临时目录，不碰真实数据）
node scripts/plugin-smoke.mjs
```

## 五、升级

```bash
# 镜像
docker compose pull && docker compose up -d

# 源码
git pull && ./standalone/start.sh      # 会重启（先 pkill -f standalone/server.js）
```

控制台账号、配置、插件都在数据卷 / `runtime/` 里，升级不受影响。

## 六、改控制台账号密码

界面上：登录后在「总览」右上角可以退出；改密码用命令行（会同时注销所有已登录会话）：

```bash
node scripts/set-password.sh <用户名> <新密码>
# 或
./scripts/set-password.sh dafeiyu 'Abc12345'
```

密码规则与界面一致：≥6 位，且同时包含大写字母、小写字母与数字。

## 七、卸载

```bash
docker rm -f qqbot && docker volume rm qqbot-data     # 镜像方式（会一并删掉数据）
pkill -f standalone/server.js                          # 源码方式
```

## 八、常见问题

| 现象 | 处理 |
|---|---|
| 打开页面提示「未登录或登录已过期」 | 正常，重新登录即可（会话 30 天） |
| 登录后只看到「必须修改账号密码」 | 出厂凭据尚未修改；按提示改完再用新账号登录 |
| 「连接」页测试失败：`10004 机器人不存在` | AppID 或 AppSecret 不对，去 QQ 开放平台核对 |
| 状态一直是 `unconfigured` | 还没保存凭据；保存后桥接会在几秒内重连 |
| 状态 `degraded` / 反复重连 | 看「日志」页；`4014` 通常是开放平台没开通群聊/单聊消息能力 |
| 模型页下拉是空的 | 还没接入服务商；先在「接入其他模型服务商」里加一个 |
| 端口占用 | `-e QQBOT_PORT=别的端口` 并同步改 `-p` |
| 想让别人也能打开控制台 | 前面加一层反向代理 + HTTPS，别把 9999 裸奔在公网 |
