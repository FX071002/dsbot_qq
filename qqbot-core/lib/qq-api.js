/**
 * Minimal QQ Bot Open Platform (QQ 开放平台) REST client.
 *
 * Uses only Node's global `fetch`, so the bundle stays dependency-free.
 * Facts encoded here come from the current official docs
 * (https://bot.q.qq.com/wiki/develop/api-v2/):
 *
 * - token:   `POST {base}/app/getAppAccessToken` with `{ appId, clientSecret }`;
 *            success is `{ access_token, expires_in }` and `expires_in` may be a
 *            string. Failures answer **HTTP 200** with a `code`, so the body is
 *            authoritative, not the status line.
 * - calls:   `Authorization: QQBot {ACCESS_TOKEN}` (capital `QQBot` + one space).
 * - errors:  OpenAPI failures carry `err_code` (sometimes only `code`); the HTTP
 *            status may be 200/201/202/401/404/405/429/500/504, so both are read.
 *
 * @module @local/dsh-qqbot/qq-api
 */

/** Refresh the access token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 300_000

/** OpenAPI error codes that mean "the access token is stale". */
const AUTH_ERROR_CODES = new Set([11244, 11245, 40011027])

/** One failed QQ OpenAPI call. */
export class QQApiError extends Error {
  /**
   * @param message - human readable summary.
   * @param options - structured failure facts.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'QQApiError'
    this.code = options.code
    this.status = options.status
    this.path = options.path
    this.body = options.body
  }
}

function errorCodeOf(body) {
  if (body === null || typeof body !== 'object') return undefined
  if (typeof body.err_code === 'number') return body.err_code
  if (typeof body.code === 'number') return body.code
  return undefined
}

/**
 * One cached-credential client for the QQ Bot OpenAPI.
 */
export class QQApi {
  #appId
  #clientSecret
  #baseUrl
  #logger
  #fetch
  #token
  #expiresAt
  #pending

  /**
   * @param options - credentials, endpoint, and diagnostics.
   */
  constructor(options) {
    this.#appId = options.appId
    this.#clientSecret = options.clientSecret
    this.#baseUrl = options.baseUrl
    this.#logger = options.logger
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#token = undefined
    this.#expiresAt = 0
    this.#pending = undefined
  }

  /** The API origin every call is resolved against. */
  get baseUrl() {
    return this.#baseUrl
  }

  /**
   * Resolve a usable access token, refreshing it when it is close to expiry.
   * @param options.force - ignore the cached token and fetch a new one.
   * @returns the bearer value expected after `QQBot `.
   */
  async accessToken(options = {}) {
    const now = Date.now()
    if (!options.force && this.#token !== undefined && now < this.#expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.#token
    }
    if (this.#pending !== undefined) return this.#pending
    this.#pending = this.#fetchToken().finally(() => {
      this.#pending = undefined
    })
    return this.#pending
  }

  async #fetchToken() {
    const response = await this.#send('POST', '/app/getAppAccessToken', {
      body: { appId: this.#appId, clientSecret: this.#clientSecret },
      auth: false
    })
    const token = typeof response.access_token === 'string' ? response.access_token : ''
    if (token === '') {
      const code = errorCodeOf(response)
      throw new QQApiError(
        `获取 AccessToken 失败：${response.message ?? '响应中没有 access_token'}` +
          `${code === undefined ? '' : `（code=${code}）`}`,
        { code, path: '/app/getAppAccessToken', body: response }
      )
    }
    const expiresIn = Number(response.expires_in)
    const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 7200_000
    this.#token = token
    this.#expiresAt = Date.now() + lifetime
    this.#logger?.info?.(`qqbot: 已获取 AccessToken，有效期约 ${Math.round(lifetime / 1000)}s`)
    return token
  }

  /**
   * Call one OpenAPI path, refreshing the token once on an auth failure.
   * @param method - HTTP method.
   * @param path - path beginning with `/`.
   * @param options - request body, auth flag, and cancellation.
   * @returns the decoded JSON body.
   */
  async call(method, path, options = {}) {
    try {
      return await this.#send(method, path, options)
    } catch (error) {
      const retryable =
        options.auth !== false &&
        error instanceof QQApiError &&
        (error.status === 401 || AUTH_ERROR_CODES.has(error.code))
      if (!retryable) throw error
      this.#logger?.warn?.(`qqbot: ${path} 鉴权失败（${error.message}），刷新 AccessToken 后重试`)
      await this.accessToken({ force: true })
      return await this.#send(method, path, options)
    }
  }

  async #send(method, path, options = {}) {
    const headers = { Accept: 'application/json' }
    if (options.auth !== false) headers.Authorization = `QQBot ${await this.accessToken()}`
    let body
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }

    let response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: options.signal
      })
    } catch (error) {
      throw new QQApiError(`请求 ${path} 失败：${error?.message ?? String(error)}`, { path })
    }

    const text = await response.text().catch(() => '')
    let decoded
    try {
      decoded = text === '' ? {} : JSON.parse(text)
    } catch {
      decoded = { raw: text }
    }

    const code = errorCodeOf(decoded)
    if (!response.ok || (options.auth !== false && code !== undefined)) {
      throw new QQApiError(
        `${method} ${path} 失败：HTTP ${response.status}` +
          `${code === undefined ? '' : ` code=${code}`} ${decoded?.message ?? decoded?.raw ?? ''}`.trim(),
        { code, status: response.status, path, body: decoded }
      )
    }
    return decoded
  }

  /**
   * Read the WebSocket gateway URL.
   * @returns the gateway descriptor (`{ url, shards, session_start_limit }`).
   */
  gateway() {
    return this.call('GET', '/gateway')
  }

  /**
   * Send one message to a group.
   * @param groupOpenid - group openid from the inbound event.
   * @param body - message body (`msg_type`, `content`, optional `msg_id`/`msg_seq`).
   */
  sendGroupMessage(groupOpenid, body) {
    return this.call('POST', `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, { body })
  }

  /**
   * Send one message to a single user (C2C).
   * @param userOpenid - user openid from the inbound event.
   * @param body - message body (`msg_type`, `content`, optional `msg_id`/`msg_seq`).
   */
  sendC2CMessage(userOpenid, body) {
    return this.call('POST', `/v2/users/${encodeURIComponent(userOpenid)}/messages`, { body })
  }

  /**
   * Send one message to whichever conversation the target names.
   * @param target - `{ scene, openid }`.
   * @param body - message body.
   */
  sendMessage(target, body) {
    return target.scene === 'group'
      ? this.sendGroupMessage(target.openid, body)
      : this.sendC2CMessage(target.openid, body)
  }
}
