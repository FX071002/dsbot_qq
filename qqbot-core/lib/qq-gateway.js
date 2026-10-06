/**
 * QQ Bot Open Platform WebSocket gateway client.
 *
 * Implemented on Node's global `WebSocket` (Node >= 22), so the bundle needs no
 * `ws` dependency. Protocol facts come from the current official docs
 * (https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html):
 *
 * - the server sends `op:10` hello with the heartbeat interval it wants;
 * - `op:2` identify carries `token: "QQBot {accessToken}"`, `intents`, `shard`;
 * - `op:1` heartbeats carry the latest dispatch `s`, or `null` before the first;
 * - `op:6` resume is tried whenever a session id and a sequence are known;
 * - close codes decide between resume, re-identify, and giving up.
 *
 * @module @local/dsh-qqbot/qq-gateway
 */

import { EventEmitter } from 'node:events'

/** Gateway opcodes. */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
}

/** Close codes that mean "this token is not accepted; fetch a new one". */
const CLOSE_AUTH_FAILED = 4004

/** Close codes that invalidate the session but still allow a fresh identify. */
const CLOSE_BAD_SESSION = new Set([4006, 4007])

/** Close codes that mean the payload/connection itself was rejected. */
const CLOSE_BAD_REQUEST = new Set([4001, 4002, 4010, 4011, 4012])

/** Close codes that permanently disable this bot. */
const CLOSE_PERMANENT = new Map([
  [4914, '机器人已下架，只允许连接沙箱环境'],
  [4915, '机器人已被封禁']
])

/** Close code meaning "the intents you asked for are not granted". */
const CLOSE_INTENT_DENIED = 4014

/** Close code meaning "the intents value itself is invalid". */
const CLOSE_INTENT_INVALID = 4013

/** Retry delay used after a failure that needs operator action. */
const SLOW_RETRY_MS = 600_000

/**
 * One self-healing gateway connection.
 *
 * Emits:
 * - `ready`    `(payload)` — identified successfully.
 * - `resumed`  `()`        — session resumed after a reconnect.
 * - `dispatch` `({ type, data, id, seq })` — one application event.
 * - `fatal`    `({ code, message, permanent })` — needs operator attention.
 * - `state`    `({ status, sessionId, lastSeq })` — connection state changes.
 */
export class QQGateway extends EventEmitter {
  #api
  #intents
  #shard
  #logger
  #ws
  #heartbeatTimer
  #reconnectTimer
  #sessionId
  #lastSeq
  #token
  #acked
  #attempt
  #stopped
  #generation
  #connectedAt

  /**
   * @param options - api client, intents, shard, and diagnostics.
   */
  constructor(options) {
    super()
    this.#api = options.api
    this.#intents = options.intents
    this.#shard = [options.shardId ?? 0, options.shardCount ?? 1]
    this.#logger = options.logger
    this.#lastSeq = null
    this.#acked = true
    this.#attempt = 0
    this.#stopped = true
    this.#generation = 0
  }

  /** A snapshot of connection state for diagnostics. */
  status() {
    const state = this.#ws?.readyState
    return {
      status: this.#stopped ? 'stopped' : state === 1 ? 'connected' : state === 0 ? 'connecting' : 'reconnecting',
      sessionId: this.#sessionId ?? null,
      lastSeq: this.#lastSeq,
      connectedAt: this.#connectedAt ?? null,
      intents: this.#intents
    }
  }

  /** Open the connection and keep it open until {@link stop}. */
  start() {
    if (typeof globalThis.WebSocket !== 'function') {
      throw new Error('qqbot: 当前 Node 运行时没有全局 WebSocket（需要 Node >= 22）')
    }
    if (!this.#stopped) return
    this.#stopped = false
    this.#attempt = 0
    this.#connect()
  }

  /** Close the connection and cancel every pending retry. */
  stop() {
    this.#stopped = true
    this.#generation += 1
    this.#clearTimers()
    const socket = this.#ws
    this.#ws = undefined
    this.#connectedAt = undefined
    if (socket !== undefined) {
      try {
        socket.close(1000, 'dsh-qqbot shutdown')
      } catch {
        /* the socket is already gone */
      }
    }
    this.#emitState()
  }

  #emitState() {
    this.emit('state', this.status())
  }

  #clearTimers() {
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = undefined
    }
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = undefined
    }
  }

  async #connect() {
    if (this.#stopped) return
    const generation = ++this.#generation

    let url
    try {
      const descriptor = await this.#api.gateway()
      url = typeof descriptor?.url === 'string' ? descriptor.url : ''
      if (url === '') throw new Error('网关响应中没有 url')
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 获取 WebSocket 网关地址失败：${error?.message ?? String(error)}`)
      this.#scheduleReconnect()
      return
    }
    if (this.#stopped || generation !== this.#generation) return

    this.#logger?.info?.(`qqbot: 正在连接 QQ 网关 ${url}`)
    let socket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 建立 WebSocket 失败：${error?.message ?? String(error)}`)
      this.#scheduleReconnect()
      return
    }
    this.#ws = socket
    this.#emitState()

    socket.addEventListener('open', () => {
      if (generation !== this.#generation) return
      this.#connectedAt = Date.now()
      this.#logger?.info?.('qqbot: WebSocket 已连接，等待 Hello')
    })

    socket.addEventListener('message', (event) => {
      if (generation !== this.#generation) return
      this.#onMessage(event.data)
    })

    socket.addEventListener('error', (event) => {
      if (generation !== this.#generation) return
      const detail = event?.error?.message ?? event?.message ?? 'unknown error'
      this.#logger?.warn?.(`qqbot: WebSocket 错误：${detail}`)
    })

    socket.addEventListener('close', (event) => {
      if (generation !== this.#generation) return
      if (this.#ws === socket) this.#ws = undefined
      this.#clearTimers()
      this.#connectedAt = undefined
      this.#emitState()
      this.#onClose(event?.code ?? 0, event?.reason ?? '')
    })
  }

  #onMessage(raw) {
    let payload
    try {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
      payload = JSON.parse(text)
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 无法解析网关消息：${error?.message ?? String(error)}`)
      return
    }
    if (payload === null || typeof payload !== 'object') return

    switch (payload.op) {
      case OP.HELLO: {
        const interval = Number(payload.d?.heartbeat_interval)
        this.#startHeartbeat(Number.isFinite(interval) && interval > 0 ? interval : 45000)
        this.#authenticate()
        return
      }
      case OP.HEARTBEAT_ACK: {
        this.#acked = true
        return
      }
      case OP.HEARTBEAT: {
        this.#sendHeartbeat()
        return
      }
      case OP.RECONNECT: {
        this.#logger?.info?.('qqbot: 服务端要求重连')
        this.#reconnect()
        return
      }
      case OP.INVALID_SESSION: {
        this.#logger?.warn?.('qqbot: 会话失效（op 9），重新鉴权')
        this.#sessionId = undefined
        this.#lastSeq = null
        this.#reconnect()
        return
      }
      case OP.DISPATCH: {
        if (typeof payload.s === 'number') this.#lastSeq = payload.s
        const type = payload.t
        if (type === 'READY') {
          this.#sessionId = payload.d?.session_id
          this.#attempt = 0
          const name = payload.d?.user?.username ?? '未知'
          this.#logger?.info?.(`qqbot: 鉴权成功，已上线为「${name}」（session=${this.#sessionId ?? '-'}）`)
          this.#emitState()
          this.emit('ready', payload.d)
          return
        }
        if (type === 'RESUMED') {
          this.#attempt = 0
          this.#logger?.info?.('qqbot: 会话已恢复（RESUMED）')
          this.#emitState()
          this.emit('resumed')
          return
        }
        this.emit('dispatch', { type, data: payload.d, id: payload.id, seq: payload.s })
        return
      }
      default:
        return
    }
  }

  #authenticate() {
    if (this.#sessionId !== undefined && this.#lastSeq !== null) {
      this.#logger?.info?.(`qqbot: 尝试恢复会话 ${this.#sessionId}（seq=${this.#lastSeq}）`)
      this.#send({
        op: OP.RESUME,
        d: {
          token: `QQBot ${this.#token ?? ''}`,
          session_id: this.#sessionId,
          seq: this.#lastSeq
        }
      })
      return
    }
    void this.#identify()
  }

  async #identify() {
    let token
    try {
      token = await this.#api.accessToken()
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 鉴权前获取 AccessToken 失败：${error?.message ?? String(error)}`)
      this.#reconnect()
      return
    }
    this.#token = token
    this.#logger?.info?.(`qqbot: 发送 identify（intents=${this.#intents}，shard=[${this.#shard.join(',')}]）`)
    this.#send({
      op: OP.IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: this.#intents,
        shard: this.#shard,
        properties: { $os: process.platform, $browser: 'dfy-qqbot', $device: 'dfy-qqbot' }
      }
    })
  }

  #startHeartbeat(intervalMs) {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer)
    this.#acked = true
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#acked) {
        this.#logger?.warn?.('qqbot: 上一轮心跳未收到 ACK，判定连接已死并重连')
        this.#reconnect()
        return
      }
      this.#sendHeartbeat()
    }, intervalMs)
    this.#heartbeatTimer.unref?.()
    this.#logger?.info?.(`qqbot: 心跳间隔 ${intervalMs}ms`)
  }

  #sendHeartbeat() {
    this.#acked = false
    this.#send({ op: OP.HEARTBEAT, d: this.#lastSeq })
  }

  #send(payload) {
    const socket = this.#ws
    if (socket === undefined || socket.readyState !== 1) return false
    try {
      socket.send(JSON.stringify(payload))
      return true
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 发送网关消息失败：${error?.message ?? String(error)}`)
      return false
    }
  }

  #reconnect() {
    this.#clearTimers()
    const socket = this.#ws
    this.#ws = undefined
    this.#generation += 1
    if (socket !== undefined) {
      try {
        socket.close(4000, 'reconnect')
      } catch {
        /* already closed */
      }
    }
    this.#emitState()
    this.#scheduleReconnect()
  }

  #scheduleReconnect(delayOverride) {
    if (this.#stopped || this.#reconnectTimer !== undefined) return
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(this.#attempt, 5))
    const delay = delayOverride ?? backoff + Math.floor(Math.random() * 500)
    this.#attempt += 1
    this.#logger?.info?.(`qqbot: ${Math.round(delay / 1000)}s 后重连（第 ${this.#attempt} 次）`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      void this.#connect()
    }, delay)
    this.#reconnectTimer.unref?.()
  }

  #onClose(code, reason) {
    if (this.#stopped) return
    const suffix = reason === '' ? '' : ` reason=${reason}`

    if (CLOSE_PERMANENT.has(code)) {
      const message = CLOSE_PERMANENT.get(code)
      this.#logger?.error?.(`qqbot: 连接被永久关闭（code=${code}）：${message}`)
      this.stop()
      this.emit('fatal', { code, message, permanent: true })
      return
    }

    if (code === CLOSE_INTENT_DENIED) {
      const message =
        `intents=${this.#intents} 未获授权（close 4014）。请在 QQ 开放平台为该机器人申请「群聊/单聊」消息能力，` +
        '或修正配置里的 intents。'
      this.#logger?.error?.(`qqbot: ${message}`)
      this.emit('fatal', { code, message, permanent: false })
      this.#scheduleReconnect(SLOW_RETRY_MS)
      return
    }

    if (code === CLOSE_INTENT_INVALID) {
      const message = `intents=${this.#intents} 不是合法值（close 4013），请检查配置。`
      this.#logger?.error?.(`qqbot: ${message}`)
      this.emit('fatal', { code, message, permanent: false })
      this.#scheduleReconnect(SLOW_RETRY_MS)
      return
    }

    if (code === CLOSE_AUTH_FAILED) {
      this.#logger?.warn?.('qqbot: 鉴权失败（close 4004），刷新 AccessToken 后重连')
      this.#sessionId = undefined
      this.#lastSeq = null
      this.#api
        .accessToken({ force: true })
        .catch(() => {})
        .finally(() => this.#scheduleReconnect())
      return
    }

    if (CLOSE_BAD_SESSION.has(code)) {
      this.#logger?.warn?.(`qqbot: 会话无法恢复（close ${code}${suffix}），改为重新鉴权`)
      this.#sessionId = undefined
      this.#lastSeq = null
      this.#scheduleReconnect()
      return
    }

    if (CLOSE_BAD_REQUEST.has(code)) {
      this.#logger?.warn?.(`qqbot: 连接被拒绝（close ${code}${suffix}），将以新会话重连`)
      this.#scheduleReconnect()
      return
    }

    this.#logger?.warn?.(`qqbot: 连接已断开（close ${code}${suffix}），准备重连`)
    this.#scheduleReconnect()
  }
}
