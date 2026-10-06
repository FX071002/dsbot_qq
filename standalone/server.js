#!/usr/bin/env node
/**
 * 独立模式入口 —— 不依赖 DeepSeek Harness 也能跑。
 *
 * 它自己完成 Harness 模式里由插件承担的三件事：连 QQ 网关、维护每会话上下文、
 * 调模型并回复；配置、人格、插件指令、状态文件与控制台都沿用同一套约定，
 * 所以同一个控制台、同一份 `runtime/qqbot.config.json` 对两种模式都成立。
 *
 *   node standalone/server.js --home=/data/dsh/home/dfy-qqbot     # 默认端口 9999
 *   QQ_BOT_APP_ID=... QQ_BOT_APP_SECRET=... node standalone/server.js
 *
 * QQ 凭据有三种来源，优先级从高到低：
 *   1. 控制台「连接」页保存进 runtime/qqbot.config.json 的 qq.appId / qq.clientSecret
 *   2. 环境变量 QQ_BOT_APP_ID / QQ_BOT_APP_SECRET
 *   3. standalone/config.json
 * 三者都没有时进程**照常运行**（先把控制台和桥接起好），只是不连 QQ 网关，
 * 等你在控制台里填好凭据后自动重连。
 *
 * 能力对照（详见 README）：
 *   ✅ 群 @ / 私聊、被动回复与降级、插件快捷指令、人格、白名单、多轮上下文、生图（函数调用）
 *   ❌ Harness 的工具链（bash / 文件 / 搜索 / 子代理）——需要这些请用 Harness 模式
 *
 * @module standalone/server
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { QQApi } from '../qqbot-core/lib/qq-api.js'
import { QQGateway } from '../qqbot-core/lib/qq-gateway.js'
import { SideChannel } from '../qqbot-core/lib/status.js'
import { composePersonaPrompt, defaultRuntimeConfig, describePersona, normalizeRuntimeConfig } from '../shared/runtime.js'
import { loadPlugins, matchCommand, runCommand } from '../shared/plugins.js'
import { generateImage, saveImage } from '../shared/image.js'
import { ChatClient, History } from './lib/chat.js'
import { createReplySender } from './lib/reply.js'
import { probeHarness, probeModel } from './lib/probe.js'

const BUILD = '2026-10-06T18:30+08:00/standalone-1'

/** 解析命令行与环境的部署参数。 */
function resolveSettings() {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const hit = argv.find((entry) => entry.startsWith(`--${name}=`))
    return hit === undefined ? fallback : hit.slice(name.length + 3)
  }
  const home = flag('home', process.env.QQBOT_HOME ?? '/data/dsh/home/dfy-qqbot')
  let file = {}
  try {
    file = JSON.parse(readFileSync(join(home, 'standalone', 'config.json'), 'utf8'))
  } catch {
    /* 该文件可选 */
  }
  return {
    home,
    runtimeDir: join(home, 'runtime'),
    pluginsDir: join(home, 'plugins'),
    mediaDir: join(home, 'runtime', 'media'),
    sessionDir: join(home, 'runtime', 'standalone-sessions'),
    statusFile: join(home, 'qqbot-status.json'),
    logFile: join(home, 'qqbot.log'),
    configFile: join(home, 'runtime', 'qqbot.config.json'),
    // 镜像里代码在 /app、数据在卷里，两者不同目录，所以入口允许被单独指定。
    consoleEntry: flag('console-entry', process.env.QQBOT_CONSOLE_ENTRY ?? file.consoleEntry ?? join(home, 'dashboard', 'server.js')),
    appId: flag('appid', process.env.QQ_BOT_APP_ID ?? file.appId ?? ''),
    clientSecret: flag('secret', process.env.QQ_BOT_APP_SECRET ?? file.clientSecret ?? ''),
    baseUrl: flag('base-url', process.env.QQ_BOT_BASE_URL ?? file.baseUrl ?? 'https://api.bot.qq.com'),
    intents: Number(process.env.QQ_BOT_INTENTS ?? file.intents ?? 33554432),
    consoleEnabled: flag('console', process.env.QQBOT_CONSOLE ?? (file.console === false ? 'off' : 'on')) !== 'off',
    consolePort: Number(flag('port', process.env.QQBOT_PORT ?? file.port ?? 9999))
  }
}

/** 读取运行时文档（缺失时写入默认值）。 */
function loadRuntime(file, log) {
  try {
    return normalizeRuntimeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if (error?.code !== 'ENOENT') log('warn', `运行时配置读取失败，改用默认值：${error?.message ?? String(error)}`)
    const seeded = defaultRuntimeConfig()
    try {
      writeFileSync(file, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
    } catch {
      /* 只读环境 */
    }
    return seeded
  }
}

const settings = resolveSettings()
mkdirSync(settings.runtimeDir, { recursive: true })
mkdirSync(settings.pluginsDir, { recursive: true })
mkdirSync(settings.mediaDir, { recursive: true })
mkdirSync(settings.sessionDir, { recursive: true })

const side = new SideChannel({
  statusFile: settings.statusFile,
  logFile: settings.logFile,
  build: BUILD,
  logger: console
})
const log = (level, message) => side.line(level, message)

let runtime = loadRuntime(settings.configFile, log)
let plugins = loadPlugins(settings.pluginsDir)
let promptText = composePersonaPrompt(runtime, plugins.filter((p) => p.enabled && p.error === undefined))

/** QQ OpenAPI 客户端：凭据变化时整体重建。 */
let api = new QQApi({
  appId: settings.appId,
  clientSecret: settings.clientSecret,
  baseUrl: settings.baseUrl,
  logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) }
})

/** 当前生效的凭据签名，用来判断要不要重连。 */
let credentialSignature = ''

/** 解析当前该用哪套凭据（控制台 > 环境变量 > 配置文件）。 */
function resolveCredential() {
  const fromConsole = runtime.qq ?? { appId: '', clientSecret: '' }
  if (fromConsole.appId !== '' && fromConsole.clientSecret !== '') {
    return { appId: fromConsole.appId, clientSecret: fromConsole.clientSecret, source: '控制台「连接」页' }
  }
  if (settings.appId !== '' && settings.clientSecret !== '') {
    return { appId: settings.appId, clientSecret: settings.clientSecret, source: '环境变量 / standalone/config.json' }
  }
  return { appId: '', clientSecret: '', source: '未配置' }
}
const chat = new ChatClient({ runtime, logger: { warn: (m) => log('warn', m) } })
const history = new History({ dir: settings.sessionDir })
const sender = createReplySender({
  api,
  limits: { maxChars: runtime.bot.maxChars, maxChunks: runtime.bot.maxChunks },
  logger: { warn: (m) => log('warn', m) }
})
const seen = new Map()

/** 一个稳定的会话键：群按群、私聊按人。 */
function sessionKeyFor(scene, groupOpenid, senderOpenid) {
  const raw = scene === 'group' ? `group:${groupOpenid}` : `c2c:${senderOpenid}`
  return raw.replace(/[^A-Za-z0-9:._-]/g, '_')
}

/** 白名单与开关判定。 */
function isAdmitted(scene, senderOpenid, groupOpenid) {
  const bot = runtime.bot
  if (!bot.enabled) return false
  if (scene === 'group' && !bot.replyToGroup) return false
  if (scene === 'c2c' && !bot.replyToC2C) return false
  if (bot.allowedUserOpenids.length > 0 && !bot.allowedUserOpenids.includes(senderOpenid)) return false
  if (bot.allowedGroupOpenids.length > 0 && scene === 'group' && !bot.allowedGroupOpenids.includes(groupOpenid)) return false
  return true
}

/** 带函数调用的补全（失败自动退回普通对话）。 */
async function replyWithModel(messages, onImage) {
  const image = runtime.capabilities.image
  if (!(runtime.capabilities.tools && image.enabled)) {
    return { text: await chat.complete(messages), imageError: undefined }
  }
  const route = chat.resolveRoute()
  if (route === undefined) return { text: await chat.complete(messages), imageError: undefined }
  try {
    const response = await fetch(`${route.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(route.apiKey === '' ? {} : { authorization: `Bearer ${route.apiKey}` })
      },
      body: JSON.stringify({
        model: route.model,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: 'qq_send_image',
              description: '根据文字描述生成一张图片并直接发送到当前 QQ 会话。用户要求画图/生成图片时调用。',
              parameters: {
                type: 'object',
                properties: { prompt: { type: 'string', description: '画面描述' } },
                required: ['prompt']
              }
            }
          }
        ]
      })
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json()
    const message = payload?.choices?.[0]?.message
    const toolCall = message?.tool_calls?.[0]
    if (toolCall === undefined) return { text: typeof message?.content === 'string' ? message.content : '', imageError: undefined }
    const args = JSON.parse(toolCall.function?.arguments ?? '{}')
    const outcome = await onImage(String(args.prompt ?? ''))
    const followUp = [
      ...messages,
      { role: 'assistant', content: message.content ?? '', tool_calls: message.tool_calls },
      { role: 'tool', tool_call_id: toolCall.id, content: outcome.ok ? '图片已发送' : `发送失败：${outcome.error}` }
    ]
    return { text: await chat.complete(followUp), imageError: outcome.ok ? undefined : outcome.error }
  } catch (error) {
    log('warn', `函数调用不可用，退回普通对话：${error?.message ?? String(error)}`)
    return { text: await chat.complete(messages), imageError: undefined }
  }
}

/** 处理一条 QQ 消息。 */
async function onMessage(event) {
  const data = event.data ?? {}
  const scene = event.type === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : 'c2c'
  const groupOpenid = typeof data.group_openid === 'string' ? data.group_openid : ''
  const senderOpenid = String(
    scene === 'group' ? data.author?.member_openid ?? data.author?.id ?? '' : data.author?.user_openid ?? data.author?.id ?? ''
  )
  const messageId = typeof data.id === 'string' ? data.id : undefined
  const content = typeof data.content === 'string' ? data.content.trim() : ''
  const target = { scene, openid: scene === 'group' ? groupOpenid : senderOpenid }

  if (target.openid === '' || senderOpenid === '') return
  if (messageId !== undefined) {
    if (seen.has(messageId)) {
      log('info', `${event.type} 重复推送（msg_id=${messageId}），已忽略`)
      return
    }
    seen.set(messageId, Date.now())
    while (seen.size > 500) {
      const oldest = seen.keys().next()
      if (oldest.done === true) break
      seen.delete(oldest.value)
    }
  }

  const where = scene === 'group' ? `群 ${groupOpenid}` : '私聊'
  const receivedAt = Date.now()
  side.state.counters.inbound += 1
  side.write({
    lastInbound: { at: new Date().toISOString(), scene, sender: senderOpenid, group: groupOpenid === '' ? null : groupOpenid, chars: content.length }
  })

  if (!isAdmitted(scene, senderOpenid, groupOpenid)) {
    side.state.counters.rejected += 1
    side.write({})
    log('warn', `${where} 的发送者 ${senderOpenid} 未被当前配置接受，已忽略`)
    return
  }
  log('info', `收到${scene === 'group' ? '群@' : '私聊'}消息 来自 ${senderOpenid}（${content.length} 字）`)
  if (content === '') return

  // 插件快捷指令优先，不花模型额度
  const hit = matchCommand(plugins, content)
  if (hit !== undefined) {
    const reply = await runCommand(hit, undefined)
    await sender.deliver(target, messageId, receivedAt, reply)
    side.state.counters.replied += 1
    side.write({ lastReply: { at: new Date().toISOString(), sessionId: null, chars: reply.length } })
    log('info', `插件「${hit.plugin.name}」命中指令 ${hit.command.label}`)
    return
  }

  if (runtime.bot.ackEnabled && runtime.bot.ackText.trim() !== '') {
    await sender.deliver(target, messageId, receivedAt, runtime.bot.ackText).catch(() => {})
  }

  const key = sessionKeyFor(scene, groupOpenid, senderOpenid)
  const header = runtime.bot.includeSenderHeader
    ? `${scene === 'group' ? '[QQ 群聊]' : '[QQ 私聊]'} 发送者 openid: ${senderOpenid}\n`
    : ''
  const messages = [
    { role: 'system', content: promptText },
    ...history.read(key),
    { role: 'user', content: `${header}${content}` }
  ]

  try {
    const { text, imageError } = await replyWithModel(messages, async (prompt) => {
      if (prompt.trim() === '') return { ok: false, error: '缺少 prompt' }
      const result = await generateImage(runtime.capabilities.image, prompt)
      if (result.ok !== true) return { ok: false, error: result.error }
      let url = result.url
      if (url === undefined && typeof result.base64 === 'string') {
        const saved = saveImage(settings.mediaDir, Buffer.from(result.base64, 'base64'), 'image/png')
        const base = runtime.capabilities.image.publicBaseUrl.replace(/\/+$/, '')
        if (base === '') return { ok: false, error: '生图只返回了图片数据，且未配置公网地址' }
        url = `${base}/media/${saved.file}`
      }
      if (url === undefined) return { ok: false, error: '生图接口没有返回可用图片' }
      await sender.sendImage(target, messageId, url)
      return { ok: true }
    })
    const answer = text.trim() !== '' ? text.trim() : imageError === undefined ? '（模型没有返回内容）' : `❌ ${imageError}`
    history.append(key, { role: 'user', content })
    history.append(key, { role: 'assistant', content: answer })
    await sender.deliver(target, messageId, receivedAt, answer)
    side.state.counters.replied += 1
    side.write({ lastReply: { at: new Date().toISOString(), sessionId: key, chars: answer.length } })
    log('info', `已回复 ${where}（${answer.length} 字，会话 ${key}）`)
  } catch (error) {
    side.state.counters.failed += 1
    side.write({ lastError: String(error?.message ?? error) })
    log('error', `处理消息失败：${error?.stack ?? String(error)}`)
    await sender.deliver(target, messageId, receivedAt, `❌ 处理失败：${error?.message ?? String(error)}`).catch(() => {})
  }
}

/** 生命周期事件：被拉群 / 加好友。 */
async function onLifecycle(event) {
  const data = event.data ?? {}
  if (event.type === 'GROUP_ADD_ROBOT') {
    const group = typeof data.group_openid === 'string' ? data.group_openid : ''
    if (group === '' || runtime.bot.welcomeGroupText.trim() === '') return
    await api.sendGroupMessage(group, { msg_type: 0, content: runtime.bot.welcomeGroupText, event_id: event.id }).catch((error) => {
      log('warn', `入群欢迎语发送失败：${error?.message ?? String(error)}`)
    })
    return
  }
  if (event.type === 'FRIEND_ADD') {
    const openid = typeof data.openid === 'string' ? data.openid : ''
    if (openid === '' || runtime.bot.welcomeFriendText.trim() === '') return
    await api.sendC2CMessage(openid, { msg_type: 0, content: runtime.bot.welcomeFriendText, event_id: event.id }).catch((error) => {
      log('warn', `好友欢迎语发送失败：${error?.message ?? String(error)}`)
    })
  }
}

/** 把运行时文档的变化应用到进程内状态。 */
function adoptRuntime(next, reason) {
  runtime = next
  plugins = loadPlugins(settings.pluginsDir)
  promptText = composePersonaPrompt(runtime, plugins.filter((p) => p.enabled && p.error === undefined))
  chat.use(runtime)
  syncCredential(reason === 'startup' ? 'startup' : 'runtime')
  publishStatus()
  log(
    'info',
    `已应用运行时配置（revision=${runtime.revision}，人格=${describePersona(runtime)}，` +
      `工具=${runtime.capabilities.tools ? '开' : '关'}，联网=${runtime.capabilities.web ? '开' : '关'}，` +
      `生图=${runtime.capabilities.image.enabled ? '开' : '关'}，插件=${plugins.filter((p) => p.enabled).length}/${plugins.length}）` +
      (reason === 'startup' ? '' : '')
  )
}

/** 发布状态（控制台读它）。 */
function publishStatus() {
  const route = chat.resolveRoute()
  side.write({
    runtime: {
      revision: runtime.revision,
      personaName: describePersona(runtime),
      personaChars: promptText.length,
      botEnabled: runtime.bot.enabled,
      capabilities: {
        tools: runtime.capabilities.tools,
        web: runtime.capabilities.web,
        image: runtime.capabilities.image.enabled
      },
      deniedTools: runtime.capabilities.deniedTools,
      effectiveDeny: [],
      plugins: { total: plugins.length, enabled: plugins.filter((p) => p.enabled).length },
      tools: [],
      agentTools: [],
      model: { ...runtime.models.chat },
      chatSelection: route === undefined ? null : { provider: route.provider, model: route.model },
      harnessModel: null,
      harnessLock: { lock: false, provider: '', model: '', reasoningEffort: '' },
      providers: runtime.models.providers.map((entry) => ({
        route: entry.route,
        displayName: entry.displayName,
        baseURL: entry.baseURL,
        api: entry.api,
        models: entry.models.length,
        hasKey: entry.apiKey !== ''
      })),
      liveAgents: 0,
      mode: 'standalone',
      qq: {
        configured: credentialSignature !== '',
        appId: resolveCredential().appId,
        source: resolveCredential().source
      }
    }
  })
}

/** 控制通道：与 Harness 模式同一套请求/应答文件协议。 */
const controlFile = join(settings.runtimeDir, 'control.json')
const controlResultFile = join(settings.runtimeDir, 'control-result.json')
let lastControlId = ''

async function handleControl(request) {
  const id = typeof request?.id === 'string' ? request.id : ''
  const action = typeof request?.action === 'string' ? request.action : ''
  let ok = true
  let message = ''
  let payload
  try {
    if (action === 'reconnect') {
      if (gateway === undefined) throw new Error('尚未配置 QQ 凭据，请先在「连接」页填写 AppID 与 AppSecret')
      gateway.stop()
      gateway.start()
      message = '已重启 QQ 网关连接'
    } else if (action === 'test-connection') {
      const credential = resolveCredential()
      if (credential.appId === '' || credential.clientSecret === '') {
        throw new Error('还没有可用的凭据：请在「连接」页填写 AppID 与 AppSecret（或用环境变量提供）')
      }
      const token = await api.accessToken({ force: true })
      const descriptor = await api.gateway()
      message = `凭据（${credential.source}，AppID ${credential.appId}）鉴权成功：token ${String(token).slice(0, 8)}…，网关 ${descriptor?.url ?? '未知'}`
    } else if (action === 'test-harness') {
      const outcome = await probeHarness({
        baseUrl: String(request?.payload?.baseUrl ?? runtime.harness.baseUrl),
        apiKey: String(request?.payload?.apiKey ?? runtime.harness.apiKey)
      })
      ok = outcome.ok
      message = outcome.message
    } else if (action === 'reload-config') {
      adoptRuntime(loadRuntime(settings.configFile, log), 'control')
      message = `已重新读取运行时配置（revision=${runtime.revision}）`
    } else if (action === 'test-model') {
      const kind = String(request?.payload?.kind ?? 'chat')
      const route = kind === 'chat' ? chat.resolveRoute() : undefined
      const provider = String(request?.payload?.provider ?? route?.provider ?? '')
      const model = String(request?.payload?.model ?? route?.model ?? '')
      if (provider === '' || model === '') throw new Error('还没选择服务商与模型')
      const outcome = await probeModel({ runtime, kind, provider, model, chat })
      ok = outcome.ok
      message = outcome.message
    } else if (action === 'discover-models') {
      const baseURL = String(request?.payload?.baseURL ?? '').replace(/\/+$/, '')
      if (baseURL === '') throw new Error('缺少 baseURL')
      const key = String(request?.payload?.apiKey ?? '')
      const response = await fetch(`${baseURL}/models`, {
        headers: key === '' ? {} : { authorization: `Bearer ${key}` }
      })
      if (!response.ok) throw new Error(`服务商返回 HTTP ${response.status}`)
      const body = await response.json()
      const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
      payload = { models: list.map((item) => ({ id: String(item.id ?? item.name ?? ''), name: String(item.name ?? item.id ?? '') })).filter((m) => m.id !== '') }
      ok = payload.models.length > 0
      message = ok ? `发现 ${payload.models.length} 个模型` : '服务商没有返回任何模型'
    } else {
      ok = false
      message = `未知指令：${action || '(空)'}`
    }
  } catch (error) {
    ok = false
    message = error?.message ?? String(error)
  }
  try {
    writeFileSync(
      controlResultFile,
      `${JSON.stringify({ id, action, ok, message, ...(payload === undefined ? {} : { payload }), at: new Date().toISOString() })}\n`,
      { mode: 0o600 }
    )
  } catch {
    /* 忽略 */
  }
  log(ok ? 'info' : 'warn', `控制指令 ${action || '(空)'} → ${ok ? '成功' : '失败'}：${message}`)
}

function pollControl() {
  let request
  try {
    request = JSON.parse(readFileSync(controlFile, 'utf8'))
  } catch {
    return
  }
  const id = typeof request?.id === 'string' ? request.id : ''
  if (id === '' || id === lastControlId) return
  lastControlId = id
  void handleControl(request)
}

/** 控制台进程：没在跑就拉起来（独立模式下直接监听根路径）。 */
async function ensureConsole() {
  if (!settings.consoleEnabled) return
  const origin = `http://127.0.0.1:${settings.consolePort}`
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2500) })
    if (response.ok) return
  } catch {
    /* 没在跑 */
  }
  try {
    const child = spawn(
      process.execPath,
      [settings.consoleEntry, `--home=${settings.home}`, '--host=0.0.0.0', `--port=${settings.consolePort}`],
      {
        detached: true,
        stdio: 'ignore',
        cwd: settings.home,
        env: process.env
      }
    )
    child.unref()
    log('info', `控制台未在运行，已拉起：${origin}/`)
  } catch (error) {
    log('warn', `拉起控制台失败：${error?.message ?? String(error)}`)
  }
}

/** 当前网关实例；未配置凭据时为 undefined。 */
let gateway

/** 给一个网关实例挂上所有事件处理。 */
function wireGateway(instance) {
  instance.on('dispatch', (event) => {
  if (event.type === 'GROUP_AT_MESSAGE_CREATE' || event.type === 'C2C_MESSAGE_CREATE') {
    void onMessage(event).catch((error) => log('error', String(error?.stack ?? error)))
    return
  }
  if (event.type === 'GROUP_ADD_ROBOT' || event.type === 'FRIEND_ADD') {
    void onLifecycle(event).catch((error) => log('error', String(error?.stack ?? error)))
    return
  }
    if (event.type === 'INTERACTION_CREATE') {
      const id = String(event.data?.id ?? '')
      if (id !== '') void api.call('PUT', `/interactions/${encodeURIComponent(id)}`, { body: { code: 0 } }).catch(() => {})
    }
  })
  instance.on('state', (status) =>
    side.write({ gateway: status.status, gatewaySessionId: status.sessionId, lastSeq: status.lastSeq })
  )
  instance.on('ready', (payload) => {
    side.write({ state: 'online', bot: payload?.user?.username ?? null, gatewaySessionId: payload?.session_id ?? null })
    publishStatus()
  })
  instance.on('fatal', ({ code, message, permanent }) => {
    side.state.counters.failed += 1
    side.write({ state: permanent ? 'stopped' : 'degraded', lastError: `${code}: ${message}` })
    log('error', `${permanent ? '服务已停止：' : '网关暂不可用（将稍后重试）：'}${message}`)
  })
}

/**
 * 按当前凭据对齐网关：凭据变了就整体重建（QQApi 里缓存着 token，必须一起换）。
 * 没凭据时停掉网关并进入"待配置"状态，而不是退出进程——用户会在控制台里填。
 */
function syncCredential(reason) {
  const credential = resolveCredential()
  const signature = credential.appId === '' ? '' : `${credential.appId}:${credential.clientSecret}`
  if (signature === credentialSignature && reason !== 'startup') return
  credentialSignature = signature

  if (gateway !== undefined) {
    gateway.stop()
    gateway = undefined
  }
  if (signature === '') {
    side.write({ state: 'unconfigured', bot: null, gateway: 'stopped' })
    log('warn', '尚未配置 QQ 凭据：请打开控制台「连接」页填写 AppID 与 AppSecret')
    publishStatus()
    return
  }
  api = new QQApi({
    appId: credential.appId,
    clientSecret: credential.clientSecret,
    baseUrl: settings.baseUrl,
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) }
  })
  gateway = new QQGateway({
    api,
    intents: settings.intents,
    shardId: 0,
    shardCount: 1,
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) }
  })
  wireGateway(gateway)
  gateway.start()
  log('info', `使用${credential.source}的凭据连接 QQ 网关（AppID ${credential.appId}）${reason === 'startup' ? '' : '（凭据已更新）'}`)
}

// 运行时配置热更新
let reloadTimer
const poll = setInterval(() => {
  try {
    const next = normalizeRuntimeConfig(JSON.parse(readFileSync(settings.configFile, 'utf8')))
    if (next.revision !== runtime.revision) {
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => adoptRuntime(next, 'watch'), 150)
    }
  } catch {
    /* 文件正在被写，下一轮再读 */
  }
  pollControl()
}, 700)
// 注意：这里刻意 *不* unref —— 独立模式没有宿主进程，这个定时器同时负责
// 保持事件循环存活；unref 会让进程在网关断线重连的空档里直接退出。

adoptRuntime(runtime, 'startup')
void ensureConsole()
log(
  'info',
  `独立模式已启动（build=${BUILD}，intents=${settings.intents}，工作目录 ${settings.home}，` +
    `控制台 ${settings.consoleEnabled ? `http://127.0.0.1:${settings.consolePort}/` : '未启用'}）`
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', `${signal} received, shutting down`)
    clearInterval(poll)
    gateway?.stop()
    side.write({ state: 'stopped' })
    setTimeout(() => process.exit(0), 300).unref()
  })
}
