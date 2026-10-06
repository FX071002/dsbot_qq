# 接上 DeepSeek Harness（可选）

本项目**不需要** Harness 就能完整运行。只有当你想让 QQ 机器人拥有 Harness 的工具链
（联网搜索、读写文件、执行命令、子代理）与完整会话审计时，才需要接上它。

控制台里的「**Harness 服务**」页负责配置连接信息；本页负责真正把桥接装进 Harness。

## 一、Harness 服务页填什么

| 字段 | 说明 |
|---|---|
| 启用 | 只是标记"这个控制台关联了一个 Harness"，不填也能用独立模式 |
| 服务商 | DeepSeek / OpenAI / 自定义（点预设会带上默认接口地址） |
| 接口地址 | Harness 的入口地址，例如 `https://你的域名:10001` 或 `http://127.0.0.1:3080` |
| API Key | 如果前面挂了反代要求 Basic Auth 或令牌，填在这里 |
| 默认模型 | 想在这个 Harness 上用的模型名（留空也行） |

点「测试连接」会依次请求 `{地址}/healthz` 与 `{地址}`，把观察到的 HTTP 状态如实回报：
任何 HTTP 回应都说明地址通了，2xx 才算"服务正常"。

页面下半部分的「**主干锁定**」是可选项：开启后，Harness 的默认模型会被钉在你选的那个上，
被别的操作改掉时守护会在 20 秒内恢复并写一条日志。

## 二、把桥接装进 Harness

在 Harness 所在的机器上：

```bash
git clone https://github.com/FX071002/dsbot_qq.git
cd dsbot_qq
export QQ_BOT_APP_ID=你的AppID
export QQ_BOT_APP_SECRET=你的AppSecret
./install.sh
```

`install.sh` 会：

1. 把 `qqbot-core/ dashboard/ shared/ standalone/ scripts/` 铺到 `$QQBOT_HOME`；
2. 用环境变量把凭据写进 `qqbot-core/cordis.patch.yml`（权限 600）；
3. 执行 `dsh plugin --profile <PROFILE> add $QQBOT_HOME/qqbot-core` 注册插件；
4. 起控制台进程。

之后控制台会挂在 Harness 自己的 Web 入口下：`https://<Harness 地址>/qqbot/`（沿用你的入口与登录）。

## 三、两种模式不要同时连

QQ 开放平台侧同一时间只应有一条网关连接，所以切换时**先停一边**：

```bash
# 切到 Harness 模式
pkill -f standalone/server.js                 # 停独立模式
# 并把插件配置里的 enabled 改成 true，触发一次重载

# 切回独立模式
# 把插件配置里的 enabled 改成 false（或停掉 Harness 里的这个插件）
QQBOT_HOME=/data/dsh/home/dfy-qqbot ./standalone/start.sh
```

> 提示：如果 Harness 承担了你唯一的 HTTPS 入口，停掉它就等于没有入口了。
> 独立模式的控制台监听 `9999`，记得把端口发布出去，否则外网访问不到控制台
> （QQ 里的对话不受影响）。

## 四、Harness 模式的额外能力

| 能力 | 独立模式 | Harness 模式 |
|---|---|---|
| 联网搜索 / 网页抓取 | ❌ | ✅ |
| 读写文件 / 执行命令 | ❌ | ✅ |
| 子代理、技能、MCP | ❌ | ✅ |
| 每个 QQ 会话在 Harness 界面可见、可审批、可审计 | ❌ | ✅ |
| 对话 / 人格 / 白名单 / 插件指令 / 生图 | ✅ | ✅ |

配置（人格、白名单、五类模型、服务商、插件）两种模式**完全共用**，切换不需要重配。
