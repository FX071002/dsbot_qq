/**
 * The bridge implementation.
 *
 * `index.js` is a stable loader that imports this module with a fresh URL on
 * every reload; everything here is therefore disposable: `mount()` returns one
 * disposer that unwinds every registration it made.
 *
 * Responsibilities:
 * - keep the QQ gateway connected and answer inbound messages;
 * - apply the dashboard-authored runtime document to every QQ Agent, live;
 * - expose capability switches (tools / web / image) as per-Agent registrations;
 * - run plugin shortcut commands without spending a model call.
 *
 * @module @local/dsh-qqbot-hub/app
 */

import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// Every local module is imported through this module's own URL query so a
// reload of `app.js` reloads the whole import graph behind it.
const V = new URL(import.meta.url).search

const { normalizeConfig } = await import(`./config.js${V}`)
const { QQApi, QQApiError } = await import(`./qq-api.js${V}`)
const { QQGateway } = await import(`./qq-gateway.js${V}`)
const { SessionBridge } = await import(`./bridge.js${V}`)
const { SideChannel } = await import(`./status.js${V}`)
const {
  defaultRuntimeConfig,
  normalizeRuntimeConfig,
  composePersonaPrompt,
  describePersona
} = await import(`../../shared/runtime.js${V}`)
const { loadPlugins, matchCommand, runCommand } = await import(`../../shared/plugins.js${V}`)
const { generateImage, saveImage, downloadImage } = await import(`../../shared/image.js${V}`)

/** Build marker recorded in the status document. */
export const BUILD = '2026-10-06T16:38+08:00/6'

/** Passive-reply failures that mean "reply to this message id is no longer allowed". */
const PASSIVE_UNAVAILABLE = new Set([40034005, 40034128, 40034024, 40034025, 40034026, 304103])

/** Passive replies accepted per inbound message, by scene. */
const PASSIVE_LIMITS = { group: 5, c2c: 4 }

/** Passive-reply windows, by scene, in milliseconds. */
const PASSIVE_WINDOWS = { group: 5 * 60_000, c2c: 60 * 60_000 }

/** How many acknowledged message ids and reply counters to remember. */
const DEDUPE_LIMIT = 500

/** Tools hidden when the 联网 switch is off. */
const WEB_TOOLS = ['web_search', 'web_fetch']

/**
 * Split one model answer into QQ-sized messages.
 * @param text - the raw answer.
 * @param maxChars - soft per-message limit.
 * @param maxChunks - hard cap on how many messages one answer may become.
 * @returns the messages to send, in order.
 */
export function splitText(text, maxChars, maxChunks) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (normalized === '') return []
  const chunks = []
  let rest = normalized
  while (rest !== '' && chunks.length < maxChunks) {
    if (rest.length <= maxChars) {
      chunks.push(rest)
      rest = ''
      break
    }
    let cut = rest.lastIndexOf('\n\n', maxChars)
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = maxChars
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '' && chunks.length > 0) {
    chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n…（内容较长，已截断）`
  }
  return chunks.filter((chunk) => chunk !== '')
}

/** Remember one key in insertion order, evicting the oldest entries. */
function remember(map, key) {
  if (map.has(key)) return false
  map.set(key, Date.now())
  while (map.size > DEDUPE_LIMIT) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
  }
  return true
}

/**
 * Mount the bridge for one plugin lifetime.
 * @param ctx - host plugin context.
 * @param config - the plugin row's raw config.
 * @returns an async disposer that unwinds everything this mount registered.
 */
export async function mount(ctx, config) {
  const settings = normalizeConfig(config, process.cwd())
  const side = new SideChannel({
    statusFile: settings.statusFile,
    logFile: settings.logFile,
    build: BUILD,
    logger: ctx.logger
  })
  const log = (level, message) => side.line(level, message)

  const noop = async () => {}
  if (!settings.enabled) {
    log('info', '配置中 enabled=false，未启动')
    side.write({ state: 'disabled' })
    return noop
  }
  if (settings.appId === '' || settings.clientSecret === '') {
    log('warn', '缺少 appId 或 clientSecret，服务保持待机（不会连接 QQ）')
    side.write({ state: 'unconfigured' })
    return noop
  }

  mkdirSync(settings.runtimeDir, { recursive: true })
  mkdirSync(settings.pluginsDir, { recursive: true })
  mkdirSync(settings.mediaDir, { recursive: true })

  const runtimeFile = join(settings.runtimeDir, 'qqbot.config.json')
  const catalogFile = join(settings.runtimeDir, 'model-catalog.json')

  // ---------------------------------------------------------------- runtime

  /** Read the dashboard-authored runtime document, seeding defaults once. */
  function loadRuntime() {
    try {
      return normalizeRuntimeConfig(JSON.parse(readFileSync(runtimeFile, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') log('warn', `运行时配置读取失败，改用默认值：${error?.message ?? String(error)}`)
      const seeded = defaultRuntimeConfig()
      try {
        writeFileSync(runtimeFile, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
        log('info', `已生成默认运行时配置 ${runtimeFile}`)
      } catch (writeError) {
        log('warn', `写入默认运行时配置失败：${writeError?.message ?? String(writeError)}`)
      }
      return seeded
    }
  }

  let runtime = loadRuntime()
  let plugins = loadPlugins(settings.pluginsDir)
  let promptText = composePersonaPrompt(runtime, enabledPluginPrompts())

  function enabledPluginPrompts() {
    return plugins.filter((plugin) => plugin.enabled && plugin.error === undefined)
  }

  // ------------------------------------------------------------- qq plumbing

  const api = new QQApi({
    appId: settings.appId,
    clientSecret: settings.clientSecret,
    baseUrl: settings.baseUrl,
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) }
  })
  const bridge = new SessionBridge({
    ctx,
    config: {
      sessionCwd: settings.sessionCwd,
      sessionPrefix: settings.sessionPrefix,
      turnTimeoutMs: settings.turnTimeoutMs
    },
    logger: { warn: (m) => log('warn', m) }
  })

  const pending = new Map()
  const replySeqs = new Map()
  const conversations = new Map()
  const agentDisposers = new Map()
  // Conversations that predate the current Session epoch still carry a persona
  // registration made by an earlier plugin generation. That scope cannot be
  // revoked from outside, so those sessions are simply left alone (new
  // conversations use a fresh epoch and are unaffected); warn once, not per apply.
  const staleAgents = new Set()

  // The tool list is only observable from a live QQ Agent, so the previous
  // generation's list is carried across reloads to keep the console populated.
  let lastVisibleTools = []
  let lastAgentTools = []
  try {
    const previous = JSON.parse(readFileSync(settings.statusFile, 'utf8'))
    if (Array.isArray(previous?.runtime?.tools)) lastVisibleTools = previous.runtime.tools
    if (Array.isArray(previous?.runtime?.agentTools)) lastAgentTools = previous.runtime.agentTools
  } catch {
    /* first run */
  }

  /** Claim the next passive-reply sequence number for one inbound message. */
  function nextSeq(messageId) {
    const next = (replySeqs.get(messageId) ?? 0) + 1
    replySeqs.set(messageId, next)
    while (replySeqs.size > DEDUPE_LIMIT) {
      const oldest = replySeqs.keys().next()
      if (oldest.done === true) break
      replySeqs.delete(oldest.value)
    }
    return next
  }

  /** Whether one inbound message may drive an Agent. */
  function isAdmitted(scene, senderOpenid, groupOpenid) {
    if (!runtime.bot.enabled) return false
    if (scene === 'group' && !runtime.bot.replyToGroup) return false
    if (scene === 'c2c' && !runtime.bot.replyToC2C) return false
    if (runtime.bot.allowedUserOpenids.length > 0 && !runtime.bot.allowedUserOpenids.includes(senderOpenid)) return false
    if (runtime.bot.allowedGroupOpenids.length > 0 && scene === 'group' && !runtime.bot.allowedGroupOpenids.includes(groupOpenid)) {
      return false
    }
    return true
  }

  /** Send one QQ message, falling back from passive to active when needed. */
  async function sendBody(target, body, messageId) {
    const withPassive = messageId === undefined ? body : { ...body, msg_id: messageId, msg_seq: nextSeq(messageId) }
    try {
      return await api.sendMessage(target, withPassive)
    } catch (error) {
      const recoverable =
        messageId !== undefined &&
        error instanceof QQApiError &&
        (PASSIVE_UNAVAILABLE.has(error.code) || error.code === 40054005)
      if (!recoverable) throw error
      log('warn', `被动回复不可用（code=${error.code}），改用主动消息`)
      const { msg_id: _ignoredId, msg_seq: _ignoredSeq, ...active } = withPassive
      return await api.sendMessage(target, active)
    }
  }

  /**
   * Send one answer, as a passive reply while that is still allowed and as a
   * proactive message once the window or the reply budget is exhausted.
   */
  async function deliver(target, messageId, receivedAt, text) {
    const chunks = splitText(text, runtime.bot.maxChars, runtime.bot.maxChunks)
    if (chunks.length === 0) return
    const window = PASSIVE_WINDOWS[target.scene] ?? PASSIVE_WINDOWS.c2c
    const limit = PASSIVE_LIMITS[target.scene] ?? PASSIVE_LIMITS.c2c
    for (const chunk of chunks) {
      const used = replySeqs.get(messageId) ?? 0
      const passive = messageId !== undefined && Date.now() - receivedAt < window - 2000 && used < limit
      await sendBody(target, { msg_type: 0, content: chunk }, passive ? messageId : undefined)
    }
  }

  /** Send best-effort feedback that never breaks the inbound event loop. */
  async function safeDeliver(target, messageId, receivedAt, text) {
    try {
      await deliver(target, messageId, receivedAt, text)
    } catch (error) {
      side.state.counters.failed += 1
      side.write({ lastError: String(error?.message ?? error) })
      log('error', `发送消息失败：${error?.message ?? String(error)}`)
    }
  }

  /** Upload one image and send it into a conversation. */
  async function sendImageToConversation(conversation, url) {
    const uploadPath =
      conversation.scene === 'group'
        ? `/v2/groups/${encodeURIComponent(conversation.openid)}/files`
        : `/v2/users/${encodeURIComponent(conversation.openid)}/files`
    const uploaded = await api.call('POST', uploadPath, {
      body: { file_type: 1, url, srv_send_msg: false }
    })
    const fileInfo = uploaded?.file_info
    if (typeof fileInfo !== 'string' || fileInfo === '') throw new Error('上传图片后没有拿到 file_info')
    await sendBody(
      { scene: conversation.scene, openid: conversation.openid },
      { msg_type: 7, media: { file_info: fileInfo } },
      conversation.msgId
    )
  }

  // --------------------------------------------------------- agent wiring

  /** Global tool names, used to keep restrictions valid. */
  function globalToolNames() {
    const tools = ctx.get('tools')
    if (tools === undefined) return new Set()
    try {
      return new Set(tools.schemas().map((schema) => schema.name))
    } catch {
      return new Set()
    }
  }

  /**
   * The tools one agent can actually see. `schemas(agent)` is the agent-scoped
   * view — the unscoped view is empty, because agent presets register their
   * tools in the preset scope rather than globally.
   */
  function visibleToolsFor(agent) {
    const tools = ctx.get('tools')
    if (tools === undefined) return []
    try {
      return tools.schemas(agent).map((schema) => ({
        name: schema.name,
        description: String(schema.description ?? '').split('\n')[0].slice(0, 120)
      }))
    } catch {
      return []
    }
  }

  /** Names `restrict()` reports as restrictable when it rejects an unknown one. */
  function knownRestrictableFrom(error) {
    const match = /known global tools: (.*)$/m.exec(String(error?.message ?? ''))
    if (match === null) return undefined
    const list = match[1].trim()
    if (list === '' || list === '(none)') return new Set()
    return new Set(list.split(',').map((name) => name.trim()).filter((name) => name !== ''))
  }

  /** The deny list the capability switches imply for one agent's visible tools. */
  function desiredDenyNames(agent) {
    const visible = visibleToolsFor(agent).map((tool) => tool.name)
    if (!runtime.capabilities.tools) return visible
    const wanted = new Set(runtime.capabilities.deniedTools)
    if (!runtime.capabilities.web) for (const name of WEB_TOOLS) wanted.add(name)
    return visible.filter((name) => wanted.has(name))
  }

  /** The deny list the current switches resolve to over the known tool set. */
  function effectiveDenyNames() {
    const names = lastVisibleTools.map((tool) => tool.name)
    if (!runtime.capabilities.tools) return names
    const wanted = new Set(runtime.capabilities.deniedTools)
    if (!runtime.capabilities.web) for (const name of WEB_TOOLS) wanted.add(name)
    return names.filter((name) => wanted.has(name))
  }

  /**
   * Register one restriction, narrowed to names this specific agent may
   * actually restrict. Scope-local registrations (such as this plugin's own
   * image tool) are rejected by `restrict()`, so the rejection itself is used
   * to learn the exact restrictable set instead of guessing.
   */
  function restrictAgentTools(agent, names) {
    let candidates = names
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (candidates.length === 0) return undefined
      const list = candidates
      try {
        return agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: list }))
      } catch (error) {
        const known = knownRestrictableFrom(error)
        if (known === undefined) {
          log('warn', `为会话 ${agent.id} 限制工具失败：${error?.message ?? String(error)}`)
          return undefined
        }
        candidates = candidates.filter((name) => known.has(name))
      }
    }
    return undefined
  }

  /** The per-Agent image tool, bound to the conversation it must draw into. */
  function imageToolDefinition(agentId) {
    const image = runtime.capabilities.image
    return {
      name: 'qq_send_image',
      description:
        '根据文字描述生成一张图片，并直接发送到当前 QQ 会话。当用户要求画图、生成图片、来张图时调用；' +
        '调用后不要再重复描述图片内容，用一两句话说明已发送即可。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '画面描述，越具体越好（主体、风格、光线、构图）' },
          size: { type: 'string', description: `可选尺寸，默认 ${image.size}` }
        },
        required: ['prompt'],
        additionalProperties: false
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, url: { type: 'string' }, note: { type: 'string' } },
          required: ['ok'],
          additionalProperties: false
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value?.ok === true
                ? `图片已生成并发送到 QQ。${value.note ?? ''}`
                : `生图失败：${value?.note ?? '未知错误'}`
          }
        ]
      },
      execute: async (args, exec) => {
        const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
        if (prompt === '') return { ok: false, note: '缺少 prompt' }
        const conversation = conversations.get(String(agentId))
        if (conversation === undefined) return { ok: false, note: '当前会话没有可用的 QQ 目标（可能来自 Harness 界面而非 QQ）' }
        const result = await generateImage(image, prompt, {
          size: typeof args?.size === 'string' && args.size !== '' ? args.size : undefined,
          signal: exec?.signal
        })
        if (result.ok !== true) return { ok: false, note: result.error }

        const publicBase = image.publicBaseUrl.replace(/\/+$/, '')
        /** Re-host bytes under the dashboard's public `/media` route. */
        const hostLocally = (bytes, contentType) => {
          const saved = saveImage(settings.mediaDir, bytes, contentType)
          return `${publicBase}/media/${saved.file}`
        }

        let publicUrl
        try {
          if (typeof result.url === 'string' && result.url !== '') publicUrl = result.url
          else if (typeof result.base64 === 'string') {
            if (publicBase === '') {
              return { ok: false, note: '生图接口只返回了图片数据，请在控制台填写「公网地址」以便 QQ 拉取图片' }
            }
            publicUrl = hostLocally(Buffer.from(result.base64, 'base64'), 'image/png')
          }
          if (publicUrl === undefined) return { ok: false, note: '生图接口没有返回可用图片' }
          await sendImageToConversation(conversation, publicUrl)
          return { ok: true, url: publicUrl, note: `耗时 ${result.ms}ms` }
        } catch (error) {
          // A provider URL QQ cannot fetch is the common failure; mirror it and retry once.
          if (typeof result.url === 'string' && publicBase !== '') {
            try {
              const downloaded = await downloadImage(result.url, exec?.signal)
              const localUrl = hostLocally(downloaded.bytes, downloaded.contentType)
              await sendImageToConversation(conversation, localUrl)
              return { ok: true, url: localUrl, note: `已转存后发送（耗时 ${result.ms}ms）` }
            } catch (retryError) {
              return { ok: false, note: `发送到 QQ 失败：${retryError?.message ?? String(retryError)}` }
            }
          }
          return { ok: false, note: `发送到 QQ 失败：${error?.message ?? String(error)}` }
        }
      }
    }
  }

  /** (Re)apply persona, tool restrictions and the image tool to one Agent. */
  function applyToAgent(agent) {
    const agentId = String(agent?.id ?? '')
    const previous = agentDisposers.get(agentId)
    if (previous !== undefined) {
      agentDisposers.delete(agentId)
      try {
        previous()
      } catch {
        /* the agent scope already unwound */
      }
    }
    const disposers = []
    const attempt = (label, register) => {
      try {
        // Own the Agent-scoped registration from THIS plugin's fiber as well.
        // A registration made only on the Agent's scope outlives a plugin
        // reload, and the next generation then fails with "already registered".
        disposers.push(
          ctx.effect(() => {
            const inner = register()
            return () => {
              try {
                inner()
              } catch {
                /* the Agent scope already unwound */
              }
            }
          })
        )
      } catch (error) {
        const message = error?.message ?? String(error)
        if (/already registered/i.test(message)) {
          if (!staleAgents.has(agentId)) {
            staleAgents.add(agentId)
            log('warn', `会话 ${agentId} 属于旧会话纪元，其人格提示词由上一代注册占用，已跳过（新会话不受影响）`)
          }
          return
        }
        log('warn', `为会话 ${agentId} 应用${label}失败：${message}`)
      }
    }

    attempt('人格提示词', () =>
      agent.ctx.effect(() => agent.ctx.systemPrompt.section({ name: 'qqbot/deployment', order: 700, text: promptText }))
    )

    // Read the agent's own tool view before anything scoped is registered for it.
    // Synchronous on purpose: the selection must be durable before the first
    // prompt of this Agent is admitted, and `agent/created` is the last point
    // that is guaranteed to run before the AgentLoop releases queued input.
    try {
      applyModelToAgent(agent)
    } catch (error) {
      log('warn', `为会话 ${agentId} 应用对话模型失败：${error?.message ?? String(error)}`)
    }
    const visible = visibleToolsFor(agent)
    if (visible.length > 0) lastVisibleTools = visible
    const deny = desiredDenyNames(agent)
    if (deny.length > 0) {
      attempt('工具限制', () => restrictAgentTools(agent, deny))
    }

    if (runtime.capabilities.tools && runtime.capabilities.image.enabled) {
      attempt('生图工具', () => agent.ctx.effect(() => agent.ctx.tools.register(imageToolDefinition(agentId))))
    }

    // Read the agent's view again: this is what the model will actually see,
    // so the console can show the difference the switches made.
    const effective = visibleToolsFor(agent)
    if (effective.length > 0) lastAgentTools = effective

    agentDisposers.set(agentId, () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    })
  }

  const isQqSession = (id) => String(id ?? '').startsWith(settings.sessionPrefix)

  /** Re-apply the runtime document to every live QQ Agent. */
  function applyRuntimeToAgents() {
    const agents = ctx.get('agents')
    if (agents === undefined) return 0
    let count = 0
    for (const agent of agents.list()) {
      if (!isQqSession(agent.id)) continue
      applyToAgent(agent)
      count += 1
    }
    return count
  }

  // ------------------------------------------------------------ model policy
  //
  // Two rules this deployment must never break:
  //   1. QQ conversations may use any configured route, but the choice is a
  //      *Session-local* \`model/selection\` — never the deployment default.
  //   2. The Harness trunk (the Web UI's own conversations) stays pinned to the
  //      locked model, so switching the bot's provider cannot displace it.

  let chatSelection
  let providerSignature = ''
  let piAiNamespace
  let lockTimer
  let providerSyncTimer

  // The loader applies a settings write through its own transaction, which
  // remounts this plugin; remembering the applied signature on disk is what
  // stops the remount from writing the same configuration again forever.
  const appliedFile = join(settings.runtimeDir, 'pi-ai-applied.json')

  function readAppliedSignature() {
    try {
      return JSON.parse(readFileSync(appliedFile, 'utf8')).signature ?? ''
    } catch {
      return ''
    }
  }

  function writeAppliedSignature(signature) {
    try {
      writeFileSync(appliedFile, `${JSON.stringify({ signature, at: new Date().toISOString() })}\n`, { mode: 0o600 })
    } catch (error) {
      log('warn', `记录服务商配置指纹失败：${error?.message ?? String(error)}`)
    }
  }

  /**
   * Run one operation outside the loader's HMR transaction.
   *
   * Mounting happens inside that transaction and the async context is inherited
   * by everything scheduled here, so a settings write (which itself opens a
   * loader transaction) is rejected as nested. The HMR service exposes
   * \`executing.exit\` for exactly this purpose and uses it for its own
   * out-of-transaction work.
   */
  async function outsideTransaction(operation) {
    const storage = ctx.get('hmr')?.executing
    if (storage !== undefined && typeof storage.exit === 'function') return await storage.exit(operation)
    return await operation()
  }

  /** Run a provider sync outside the current loader transaction. */
  function scheduleProviderSync(delay = 200) {
    if (providerSyncTimer !== undefined) clearTimeout(providerSyncTimer)
    providerSyncTimer = setTimeout(() => {
      providerSyncTimer = undefined
      // Re-resolve the conversation model *after* the routes exist: one save
      // may add a provider and select it at the same time, and the first
      // resolution would otherwise run before the route is registered.
      void syncProviders()
        .catch((error) => log('warn', `同步模型服务商失败：${error?.message ?? String(error)}`))
        .then(() => refreshChatModel('providers'))
        .then(() => publishModelCatalog())
        .catch((error) => log('warn', `刷新模型失败：${error?.message ?? String(error)}`))
    }, delay)
    providerSyncTimer.unref?.()
  }

  /** Resolve the configured QQ model against the live adapter registry. */
  async function resolveChatSelection() {
    // An unset conversation model follows the trunk: that is the documented
    // default, so a cleared or never-configured console still talks.
    const configured = runtime.models.chat
    const chat =
      configured.provider === '' || configured.model === ''
        ? { ...runtime.models.harness, reasoningEffort: configured.reasoningEffort || runtime.models.harness.reasoningEffort }
        : configured
    if (chat.provider === '' || chat.model === '') return undefined
    const llm = ctx.get('llm')
    if (llm === undefined) return undefined
    const wanted = { provider: chat.provider, model: chat.model }
    try {
      const resolved = await llm.resolveCallConfig(
        chat.reasoningEffort === '' ? wanted : { ...wanted, reasoningEffort: chat.reasoningEffort }
      )
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: String(resolved.reasoningEffort) })
      }
    } catch (error) {
      // An effort the target model does not declare must not break the route.
      try {
        const fallback = await llm.resolveCallConfig(wanted)
        log('warn', `模型 ${chat.provider}/${chat.model} 不接受推理强度「${chat.reasoningEffort}」，改用其默认值：${error?.message ?? String(error)}`)
        return {
          provider: fallback.provider,
          model: fallback.model,
          ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: String(fallback.reasoningEffort) })
        }
      } catch {
        log('warn', `QQ 会话模型 ${chat.provider}/${chat.model} 当前不可用：${error?.message ?? String(error)}`)
        return undefined
      }
    }
  }

  const sameSelection = (left, right) =>
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.model === right.model &&
    (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')

  /**
   * Point one QQ Session at the configured model.
   *
   * The durable \`model/selection\` event is exactly what the Web UI's own model
   * picker writes, so this changes one conversation and nothing else.
   */
  function applyModelToAgent(agent) {
    if (chatSelection === undefined) return
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) return
    let effective
    try {
      const state = projections.stateOf(agent.session, 'modelSelection')
      effective = state?.pending ?? state?.lastUsed ?? undefined
    } catch {
      effective = undefined
    }
    if (sameSelection(effective, chatSelection)) return
    try {
      agent.session.append('model/selection', { ...chatSelection })
      log('info', `会话 ${agent.id} 的对话模型设为 ${chatSelection.provider}/${chatSelection.model}`)
    } catch (error) {
      log('warn', `为会话 ${agent.id} 设置对话模型失败：${error?.message ?? String(error)}`)
    }
  }

  /** Re-resolve the QQ model and push it to every live QQ Session. */
  async function refreshChatModel(reason) {
    chatSelection = await resolveChatSelection()
    if (chatSelection === undefined) return
    const agents = ctx.get('agents')
    if (agents === undefined) return
    let touched = 0
    for (const agent of agents.list()) {
      if (!isQqSession(agent.id)) continue
      applyModelToAgent(agent)
      touched += 1
    }
    if (reason !== 'startup' && touched > 0) {
      log('info', `QQ 会话模型已更新为 ${chatSelection.provider}/${chatSelection.model}（作用于 ${touched} 个在线会话，Harness 主干不受影响）`)
    }
    // Resolution is asynchronous, so the status snapshot taken earlier in the
    // same apply still shows the previous model; republish the settled state.
    publishRuntimeStatus()
  }

  /** Restore the locked trunk selection if anything moved it. */
  async function enforceHarnessLock() {
    const lock = runtime.models.harness
    if (!lock.lock || lock.provider === '' || lock.model === '') return
    const service = ctx.get('agentDefaultModel')
    if (service === undefined) return
    const wanted = {
      provider: lock.provider,
      model: lock.model,
      ...(lock.reasoningEffort === '' ? {} : { reasoningEffort: lock.reasoningEffort })
    }
    let current
    try {
      current = service.currentSelection()
    } catch {
      return
    }
    if (sameSelection(current, wanted)) return
    try {
      // Writing the deployment default is a Loader operation, so it must escape
      // the HMR transaction that (re)mounted this plugin — otherwise the guard
      // detects the drift but cannot correct it.
      await outsideTransaction(() => service.saveSelection(wanted))
      log(
        'warn',
        `Harness 主干模型被改成 ${current?.provider}/${current?.model}，已按锁定值恢复为 ${lock.provider}/${lock.model}`
      )
      publishRuntimeStatus()
    } catch (error) {
      log('warn', `恢复主干锁定模型失败：${error?.message ?? String(error)}`)
    }
  }

  /** The settings namespace \`llm-pi-ai\` reads its provider table from. */
  function resolvePiAiNamespace() {
    if (piAiNamespace !== undefined) return piAiNamespace
    const settings = ctx.get('settings')
    if (settings === undefined) return undefined
    try {
      const hit = settings.describe().find((entry) => String(entry?.ns ?? '').endsWith('llm-pi-ai'))
      if (hit !== undefined) piAiNamespace = String(hit.ns)
    } catch {
      /* fall back below */
    }
    if (piAiNamespace === undefined) piAiNamespace = 'llm-pi-ai'
    return piAiNamespace
  }

  /**
   * Push the console-managed OpenAI-compatible routes into \`llm-pi-ai\`.
   *
   * Credentials are written first so the adapter can resolve them the moment
   * the route appears; the provider table itself is replaced wholesale, which
   * is what makes removing a route in the console actually remove it.
   */
  async function syncProviders() {
    const settings = ctx.get('settings')
    if (settings === undefined) return
    const ready = runtime.models.providers.filter((entry) => entry.baseURL !== '' && entry.models.length > 0)
    const signature = JSON.stringify([
      ready.map((entry) => [entry.route, entry.api, entry.baseURL, entry.apiKeyEnv, entry.displayName, entry.models.map((m) => m.id)]),
      runtime.models.providers.filter((entry) => entry.apiKey !== '').map((entry) => entry.apiKeyEnv)
    ])
    if (signature === providerSignature || signature === readAppliedSignature()) {
      providerSignature = signature
      return
    }

    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      for (const entry of runtime.models.providers) {
        if (entry.apiKey === '') continue
        try {
          await credentials.set(entry.apiKeyEnv, entry.apiKey)
        } catch (error) {
          log('warn', `写入凭据 ${entry.apiKeyEnv} 失败：${error?.message ?? String(error)}`)
        }
      }
    }

    const providers = {}
    for (const entry of ready) {
      providers[entry.route] = {
        displayName: entry.displayName,
        api: entry.api,
        baseURL: entry.baseURL,
        apiKeyEnv: entry.apiKeyEnv,
        models: entry.models.map((model) => ({ id: model.id, ...(model.name === model.id ? {} : { name: model.name }) }))
      }
    }
    const namespace = resolvePiAiNamespace()
    try {
      // A settings write goes through the Loader, which serializes it with HMR.
      // When this runs during our own reload the transaction is still open and
      // is inherited by timers, so back off until it has settled.
      let attempt = 0
      for (;;) {
        try {
          await outsideTransaction(() => settings.replace(namespace, { providers }))
          break
        } catch (error) {
          const nested = /cannot be nested/i.test(String(error?.message ?? ''))
          attempt += 1
          if (!nested || attempt > 6) throw error
          await new Promise((done) => {
            const timer = setTimeout(done, Math.min(8000, 250 * 2 ** (attempt - 1)))
            timer.unref?.()
          })
        }
      }
      providerSignature = signature
      writeAppliedSignature(signature)
      // Publish the refreshed catalog so the console lists new routes at once.
      void publishModelCatalog().catch(() => {})
      log(
        'info',
        ready.length === 0
          ? '已清空控制台接入的模型服务商'
          : `已接入 ${ready.length} 个模型服务商：${ready.map((entry) => `${entry.route}(${entry.models.length} 模型)`).join('、')}`
      )
    } catch (error) {
      log('warn', `写入 llm-pi-ai 服务商配置失败：${error?.message ?? String(error)}`)
    }
  }

  /** One tiny completion, to prove a route really answers. */
  async function probeModel(request) {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('当前 profile 没有 llm 服务')
    const provider = String(request?.provider ?? runtime.models.chat.provider)
    const model = String(request?.model ?? runtime.models.chat.model)
    if (provider === '' || model === '') throw new Error('缺少 provider 或 model')
    const effort = typeof request?.reasoningEffort === 'string' && request.reasoningEffort !== '' ? request.reasoningEffort : undefined
    let resolved
    try {
      resolved = await llm.resolveCallConfig({ provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    } catch (error) {
      resolved = await llm.resolveCallConfig({ provider, model })
    }
    let text = ''
    let failure
    for await (const chunk of llm.stream({
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：可用' }] }],
      maxTokens: 64
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
    }
    if (failure !== undefined) throw new Error(`${failure.code}：${failure.message}`)
    return `${resolved.provider}/${resolved.model} 调用成功，回复：${text.trim().slice(0, 60) || '(空)'}`
  }

  /** Ask the provider what models it serves. */
  async function discoverProviderModels(request) {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('当前 profile 没有 llm 服务')
    const baseURL = String(request?.baseURL ?? '')
    if (baseURL === '') throw new Error('缺少 baseURL')
    const namespace = resolvePiAiNamespace()
    const models = await llm.discoverModels(namespace, {
      baseURL,
      ...(typeof request?.api === 'string' && request.api !== '' ? { api: request.api } : {}),
      ...(typeof request?.apiKey === 'string' && request.apiKey !== '' ? { apiKey: request.apiKey } : {}),
      ...(typeof request?.provider === 'string' && request.provider !== '' ? { provider: request.provider } : {})
    })
    return models.map((model) => ({ id: model.id, name: model.name ?? model.id }))
  }

  /** Publish the model catalog the dashboard renders as dropdowns. */
  async function publishModelCatalog() {
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (llm === undefined) return
    const providers = []
    for (const info of llm.listProviders()) {
      const entry = { id: info.id, name: info.name, models: [] }
      try {
        const models = await llm.listModels(info.id)
        for (const model of models.slice(0, 40)) {
          let reasoningEfforts = []
          let defaultEffort
          try {
            const resolved = await llm.resolveModelInfo(info.id, model.id)
            reasoningEfforts = (resolved?.reasoning?.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name }))
            defaultEffort = resolved?.reasoning?.defaultEffort
          } catch {
            /* the model advertises no reasoning controls */
          }
          entry.models.push({
            id: model.id,
            name: model.name ?? model.id,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts, defaultEffort })
          })
        }
      } catch (error) {
        entry.error = String(error?.message ?? error)
      }
      providers.push(entry)
    }
    try {
      writeFileSync(
        catalogFile,
        `${JSON.stringify({ providers, current: selection ?? null, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 }
      )
    } catch (error) {
      log('warn', `写入模型目录失败：${error?.message ?? String(error)}`)
    }
  }

  /** Publish the runtime summary the dashboard's overview page reads. */
  function publishRuntimeStatus() {
    let harnessModel = null
    try {
      harnessModel = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
    } catch {
      harnessModel = null
    }
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
        effectiveDeny: effectiveDenyNames(),
        plugins: { total: plugins.length, enabled: enabledPluginPrompts().length },
        tools: lastVisibleTools,
        agentTools: lastAgentTools,
        model: { ...runtime.models.chat },
        chatSelection: chatSelection ?? null,
        harnessModel,
        harnessLock: { ...runtime.models.harness },
        providers: runtime.models.providers.map((entry) => ({
          route: entry.route,
          displayName: entry.displayName,
          baseURL: entry.baseURL,
          api: entry.api,
          models: entry.models.length,
          hasKey: entry.apiKey !== ''
        })),
        liveAgents: agentDisposers.size
      }
    })
  }

  /** Adopt a new runtime document and push it everywhere. */
  function adoptRuntime(next, reason) {
    const previousRevision = runtime.revision
    runtime = next
    plugins = loadPlugins(settings.pluginsDir)
    promptText = composePersonaPrompt(runtime, enabledPluginPrompts())
    const touched = applyRuntimeToAgents()
    void refreshChatModel(reason).catch((error) => log('warn', `刷新 QQ 会话模型失败：${error?.message ?? String(error)}`))
    scheduleProviderSync()
    void enforceHarnessLock().catch(() => {})
    publishRuntimeStatus()
    if (previousRevision !== runtime.revision || reason === 'startup') {
      log(
        'info',
        `已应用运行时配置（revision=${runtime.revision}，人格=${describePersona(runtime)}，` +
          `工具=${runtime.capabilities.tools ? '开' : '关'}，联网=${runtime.capabilities.web ? '开' : '关'}，` +
          `生图=${runtime.capabilities.image.enabled ? '开' : '关'}，插件=${enabledPluginPrompts().length}/${plugins.length}，` +
          `已作用于 ${touched} 个在线会话）`
      )
    }
  }

  // ------------------------------------------------------------- messages

  function describe(event) {
    const data = event.data ?? {}
    const scene = event.type === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : 'c2c'
    const groupOpenid = typeof data.group_openid === 'string' ? data.group_openid : ''
    const senderOpenid =
      scene === 'group'
        ? data.author?.member_openid ?? data.author?.id ?? ''
        : data.author?.user_openid ?? data.author?.id ?? ''
    return {
      scene,
      groupOpenid,
      senderOpenid: String(senderOpenid),
      senderName: typeof data.author?.username === 'string' ? data.author.username : '',
      messageId: typeof data.id === 'string' ? data.id : undefined,
      content: typeof data.content === 'string' ? data.content.trim() : '',
      attachments: Array.isArray(data.attachments) ? data.attachments.length : 0,
      target: { scene, openid: scene === 'group' ? groupOpenid : String(senderOpenid) }
    }
  }

  async function onMessage(event) {
    const inbound = describe(event)
    if (inbound.target.openid === '' || inbound.senderOpenid === '') {
      log('warn', `收到缺少 openid 的 ${event.type} 事件，已忽略`)
      return
    }
    if (inbound.messageId !== undefined && !remember(pending, inbound.messageId)) {
      log('info', `${event.type} 重复推送（msg_id=${inbound.messageId}），已忽略`)
      return
    }

    const where = inbound.scene === 'group' ? `群 ${inbound.groupOpenid}` : '私聊'
    side.state.counters.inbound += 1
    side.write({
      lastInbound: {
        at: new Date().toISOString(),
        scene: inbound.scene,
        sender: inbound.senderOpenid,
        group: inbound.groupOpenid === '' ? null : inbound.groupOpenid,
        chars: inbound.content.length
      }
    })

    if (!isAdmitted(inbound.scene, inbound.senderOpenid, inbound.groupOpenid)) {
      side.state.counters.rejected += 1
      side.write({})
      log('warn', `${where} 的发送者 ${inbound.senderOpenid} 未被当前配置接受，已忽略`)
      return
    }

    const receivedAt = Date.now()
    log(
      'info',
      `收到${inbound.scene === 'group' ? '群@' : '私聊'}消息 来自 ${inbound.senderOpenid}` +
        `${inbound.scene === 'group' ? ` @ ${inbound.groupOpenid}` : ''}（${inbound.content.length} 字）`
    )

    if (inbound.content === '') {
      await safeDeliver(
        inbound.target,
        inbound.messageId,
        receivedAt,
        inbound.attachments > 0 ? '（我目前只能处理文本消息，图片/文件还读不了）' : '（这条消息没有文字内容）'
      )
      return
    }

    // Plugin shortcut commands answer directly and never reach the model.
    const hit = matchCommand(plugins, inbound.content)
    if (hit !== undefined) {
      const reply = await runCommand(hit, undefined)
      log('info', `插件「${hit.plugin.name}」命中指令 ${hit.command.label}`)
      await safeDeliver(inbound.target, inbound.messageId, receivedAt, reply)
      side.state.counters.replied += 1
      side.write({ lastReply: { at: new Date().toISOString(), sessionId: null, chars: reply.length } })
      return
    }

    const sessionId = bridge.sessionIdFor(inbound.target)
    conversations.set(sessionId, {
      scene: inbound.scene,
      openid: inbound.target.openid,
      msgId: inbound.messageId,
      receivedAt
    })
    while (conversations.size > DEDUPE_LIMIT) {
      const oldest = conversations.keys().next()
      if (oldest.done === true) break
      conversations.delete(oldest.value)
    }

    if (runtime.bot.ackEnabled && runtime.bot.ackText.trim() !== '') {
      await safeDeliver(inbound.target, inbound.messageId, receivedAt, runtime.bot.ackText)
    }

    const prompt = runtime.bot.includeSenderHeader
      ? `${inbound.scene === 'group' ? '[QQ 群聊]' : '[QQ 私聊]'} 发送者 openid: ${inbound.senderOpenid}` +
        `${inbound.senderName === '' ? '' : `（${inbound.senderName}）`}` +
        `${inbound.scene === 'group' ? `｜群 openid: ${inbound.groupOpenid}` : ''}\n${inbound.content}`
      : inbound.content

    let result
    try {
      result = await bridge.run(inbound.target, prompt)
    } catch (error) {
      side.state.counters.failed += 1
      side.write({ lastError: String(error?.message ?? error) })
      log('error', `处理消息失败：${error?.stack ?? String(error)}`)
      await safeDeliver(inbound.target, inbound.messageId, receivedAt, `❌ 处理失败：${error?.message ?? String(error)}`)
      return
    }

    if (result.timedOut && result.text === '') {
      await safeDeliver(
        inbound.target,
        inbound.messageId,
        receivedAt,
        '⏳ 任务还在执行中，超过等待时间。完成后请到 Harness 界面查看结果。'
      )
      return
    }
    const answer =
      result.text !== '' ? result.text : result.failure !== undefined ? `❌ ${result.failure}` : '（模型没有返回内容）'
    await safeDeliver(inbound.target, inbound.messageId, receivedAt, answer)
    side.state.counters.replied += 1
    side.write({ lastReply: { at: new Date().toISOString(), sessionId: result.sessionId, chars: answer.length } })
    log('info', `已回复 ${where}（${answer.length} 字，会话 ${result.sessionId}）`)
  }

  /** Greet a group or friend the moment the bot is added. */
  async function onLifecycle(event) {
    const data = event.data ?? {}
    if (event.type === 'GROUP_ADD_ROBOT') {
      const groupOpenid = typeof data.group_openid === 'string' ? data.group_openid : ''
      if (groupOpenid === '' || runtime.bot.welcomeGroupText.trim() === '') return
      try {
        await api.sendGroupMessage(groupOpenid, { msg_type: 0, content: runtime.bot.welcomeGroupText, event_id: event.id })
      } catch (error) {
        log('warn', `入群欢迎语发送失败：${error?.message ?? String(error)}`)
      }
      return
    }
    if (event.type === 'FRIEND_ADD') {
      const openid = typeof data.openid === 'string' ? data.openid : ''
      if (openid === '' || runtime.bot.welcomeFriendText.trim() === '') return
      try {
        await api.sendC2CMessage(openid, { msg_type: 0, content: runtime.bot.welcomeFriendText, event_id: event.id })
      } catch (error) {
        log('warn', `好友欢迎语发送失败：${error?.message ?? String(error)}`)
      }
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Mount the dashboard on the Harness web server under \`consoleRoute\`.
   *
   * The deployment exposes exactly one HTTP entry point (the Harness web
   * server, behind its authenticating reverse proxy), so the console rides it
   * instead of asking for a published port: this route strips its prefix and
   * forwards to the standalone dashboard process on loopback.
   */
  function registerConsoleRoute() {
    const webServer = ctx.get('webServer')
    if (webServer === undefined || settings.consoleRoute === '') return undefined
    const target = new URL(settings.consoleTarget)
    const prefix = settings.consoleRoute.replace(/\/+$/, '')
    const handler = (request, response) => {
      const incoming = request.url ?? '/'
      const trimmed = incoming.startsWith(prefix) ? incoming.slice(prefix.length) : incoming
      const path = trimmed === '' || trimmed.startsWith('?') ? `/${trimmed}` : trimmed
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: target.port === '' ? 80 : Number(target.port),
          method: request.method,
          path,
          headers: { ...request.headers, host: `${target.hostname}:${target.port}` }
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
          upstreamResponse.pipe(response)
        }
      )
      upstream.on('error', (error) => {
        const message = `控制台进程未就绪：${error?.message ?? String(error)}`
        if (response.headersSent) {
          response.end()
          return
        }
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        response.end(message)
      })
      request.pipe(upstream)
    }
    try {
      const dispose = webServer.register({ kind: 'prefix', path: prefix, handler })
      log('info', `控制台已挂载到 Harness Web 端口：${prefix}/ → ${settings.consoleTarget}`)
      return dispose
    } catch (error) {
      log('warn', `挂载控制台路由失败：${error?.message ?? String(error)}`)
      return undefined
    }
  }

  /**
   * Keep the console process alive.
   *
   * The console is a separate process; nothing else in this deployment would
   * start it again after a container restart, and the plugin's route would then
   * answer 502. Probing its health endpoint on every mount makes the pair
   * self-healing: the console comes back with the bridge.
   */
  async function ensureConsoleProcess() {
    if (settings.consoleRoute === '') return
    let target
    try {
      target = new URL(settings.consoleTarget)
    } catch {
      return
    }
    try {
      const response = await fetch(`${target.origin}/healthz`, { signal: AbortSignal.timeout(2500) })
      if (response.ok) return
    } catch {
      /* not answering: start it below */
    }
    if (settings.consoleAutoStart !== true) {
      log('warn', `控制台未在 ${target.origin} 应答，且 consoleAutoStart 已关闭`)
      return
    }
    try {
      const child = spawn(
        process.execPath,
        [
          settings.consoleEntry,
          '--host=0.0.0.0',
          `--port=${target.port === '' ? '80' : target.port}`,
          `--base=${settings.consoleRoute}`
        ],
        { detached: true, stdio: 'ignore', cwd: settings.home, env: process.env }
      )
      child.unref()
      // Confirm before claiming success: overlapping mounts may race here, and
      // the loser's child exits immediately on the busy port.
      await new Promise((done) => setTimeout(done, 1800))
      try {
        const confirmed = await fetch(`${target.origin}/healthz`, { signal: AbortSignal.timeout(2500) })
        if (confirmed.ok) log('info', `控制台未在运行，已拉起并确认可用：${settings.consoleRoute}/`)
      } catch {
        log('warn', `已尝试拉起控制台，但它没有在 2 秒内应答：${settings.consoleEntry}`)
      }
    } catch (error) {
      log('warn', `拉起控制台进程失败：${error?.message ?? String(error)}`)
    }
  }

  const gateway = new QQGateway({
    api,
    intents: settings.intents,
    shardId: settings.shardId,
    shardCount: settings.shardCount,
    logger: { info: (m) => log('info', m), warn: (m) => log('warn', m), error: (m) => log('error', m) }
  })

  const disposers = []
  const cleanups = []

  const consoleDispose = registerConsoleRoute()
  if (consoleDispose !== undefined) disposers.push(consoleDispose)

  const onAgentCreated = ({ agent }) => {
    if (!isQqSession(agent?.id)) return
    applyToAgent(agent)
  }
  disposers.push(ctx.on('agent/created', onAgentCreated))

  gateway.on('dispatch', (event) => {
    if (settings.logPayloads) log('info', `dispatch ${event.type} ${JSON.stringify(event.data).slice(0, 2000)}`)
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
      if (id === '') return
      void api.call('PUT', `/interactions/${encodeURIComponent(id)}`, { body: { code: 0 } }).catch(() => {})
    }
  })

  gateway.on('state', (status) => {
    side.write({ gateway: status.status, gatewaySessionId: status.sessionId, lastSeq: status.lastSeq })
  })
  gateway.on('ready', (payload) => {
    side.write({ state: 'online', bot: payload?.user?.username ?? null, gatewaySessionId: payload?.session_id ?? null })
    publishRuntimeStatus()
  })
  gateway.on('fatal', ({ code, message, permanent }) => {
    side.state.counters.failed += 1
    side.write({ state: permanent ? 'stopped' : 'degraded', lastError: `${code}: ${message}` })
    log('error', `${permanent ? '服务已停止：' : '网关暂不可用（将稍后重试）：'}${message}`)
  })

  // Watch the runtime document: dashboard edits apply without a restart.
  let reloadTimer
  const scheduleAdopt = (reason) => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      try {
        adoptRuntime(loadRuntime(), reason)
      } catch (error) {
        log('error', `应用运行时配置失败：${error?.stack ?? String(error)}`)
      }
    }, 200)
  }
  reloadTimer?.unref?.()

  // Control channel: the dashboard drops a request file and reads the answer
  // back from a result file, so it can drive actions that only the Host can do.
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
        gateway.stop()
        gateway.start()
        message = '已重启 QQ 网关连接'
      } else if (action === 'test-connection') {
        const token = await api.accessToken({ force: true })
        const descriptor = await api.gateway()
        message = `鉴权成功：token ${String(token).slice(0, 8)}…，网关 ${descriptor?.url ?? '未知'}`
      } else if (action === 'test-model') {
        message = await probeModel(request.payload)
      } else if (action === 'discover-models') {
        const found = await discoverProviderModels(request.payload)
        ok = found.length > 0
        message = ok ? `发现 ${found.length} 个模型：${found.map((m) => m.id).join('、')}` : '服务商没有返回任何模型'
        payload = { models: found }
      } else if (action === 'reload-config') {
        adoptRuntime(loadRuntime(), 'control')
        message = `已重新读取运行时配置（revision=${runtime.revision}）`
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
    } catch (error) {
      log('warn', `写入控制结果失败：${error?.message ?? String(error)}`)
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

  try {
    const watcher = watch(settings.runtimeDir, { persistent: true }, (_event, filename) => {
      const name = filename === null ? '' : String(filename)
      if (name === '' || name === 'qqbot.config.json') scheduleAdopt('watch')
      if (name === '' || name === 'control.json') pollControl()
    })
    watcher.unref?.()
    cleanups.push(() => watcher.close())
  } catch (error) {
    log('warn', `监听运行时目录失败（配置改动需重启 Harness 才生效）：${error?.message ?? String(error)}`)
  }

  // Periodic model-catalog refresh for the dashboard's dropdowns.
  const catalogTimer = setInterval(() => {
    void publishModelCatalog().catch(() => {})
  }, settings.modelCatalogEveryMs)
  catalogTimer.unref?.()

  gateway.start()
  adoptRuntime(runtime, 'startup')
  void ensureConsoleProcess().catch((error) => log('warn', `控制台自愈检查失败：${error?.message ?? String(error)}`))
  const startupModels = () =>
    refreshChatModel('startup')
      .then(() => enforceHarnessLock())
      .then(() => publishModelCatalog())
      .catch((error) => log('warn', `初始化模型配置失败：${error?.message ?? String(error)}`))
  // Providers first — but outside the mount transaction, so the settings write
  // is accepted (and its reload finds the signature already applied).
  providerSyncTimer = setTimeout(() => {
    providerSyncTimer = undefined
    void syncProviders()
      .catch((error) => log('warn', `同步模型服务商失败：${error?.message ?? String(error)}`))
      .then(startupModels)
  }, 200)
  providerSyncTimer.unref?.()
  void startupModels()
  lockTimer = setInterval(() => {
    void enforceHarnessLock().catch(() => {})
  }, 20000)
  lockTimer.unref?.()

  log(
    'info',
    `桥接已启动（build=${BUILD}，intents=${settings.intents}，工作目录 ${settings.sessionCwd}，运行时目录 ${settings.runtimeDir}）`
  )

  return async function dispose() {
    clearTimeout(reloadTimer)
    clearInterval(catalogTimer)
    if (lockTimer !== undefined) clearInterval(lockTimer)
    if (providerSyncTimer !== undefined) clearTimeout(providerSyncTimer)
    gateway.stop()
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup()
      } catch {
        /* already torn down */
      }
    }
    for (const disposeAgent of [...agentDisposers.values()].reverse()) {
      try {
        disposeAgent()
      } catch {
        /* the agent scope already unwound */
      }
    }
    agentDisposers.clear()
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* the owning fiber already unwound */
      }
    }
    side.write({ state: 'stopped' })
    log('info', '桥接已停止')
  }
}
