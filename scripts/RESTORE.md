# 整站恢复说明

本备份是**完整实例**：代码 + 运行时配置 + 凭据 + 已装插件 + 文档，按绝对路径打包。
**内含 QQ AppSecret 与控制台口令，请勿上传到任何公开位置。**

## 一、恢复（目标是运行 DeepSeek Harness 的那个容器）

```bash
tar -xzf qqbot-site-<时间戳>.tar.gz -C /          # 按原路径覆盖 /data/dsh/...
dsh plugin --profile web add /data/dsh/home/dfy-qqbot/qqbot-core   # 若 profile 未注册
cd /data/dsh/home/dfy-qqbot && ./install.sh --no-plugin            # 起控制台并核对
```

## 二、核对的四件事

| 项 | 位置 | 期望 |
|---|---|---|
| QQ 凭据 | `qqbot-core/cordis.patch.yml` | `appId` / `clientSecret` 已填（600） |
| 控制台口令 | `runtime/dashboard-token.txt` | 沿用同一口令 |
| 运行时配置 | `runtime/qqbot.config.json` | 人格 / 能力 / 模型 / 服务商 |
| profile 注册 | `/data/dsh/profiles/web/package.json` | bundles 含 `@local/dsh-qqbot-core` |

## 三、验证

```bash
head -12 /data/dsh/home/dfy-qqbot/qqbot-status.json     # state 应为 online
curl -s http://127.0.0.1:9999/healthz              # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/qqbot/   # 200
```

## 四、如果连容器都没了

1. 用同一镜像重起容器，端口映射照旧（宿主 10001 → 容器 8443）；
2. 一并恢复 Harness 自己的数据：`/data/dsh/sessions`（会话历史）、`/data/dsh/.credentials.yaml`（凭据库）、`/data/dsh/profiles`；
3. 恢复后按第一、二节操作；
4. 在 1Panel 里把该容器**重启策略设为 always**，宿主重启后自动拉起。

## 五、之后怎么再备份

```bash
bash /data/dsh/home/dfy-qqbot/repo/scripts/make-backup.sh
```
