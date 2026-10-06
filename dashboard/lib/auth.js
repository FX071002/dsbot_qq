/**
 * Dashboard 账号：用户名 + 密码登录。
 *
 * 密码以 scrypt 加盐哈希存储（`runtime/dashboard.auth.json`，权限 600），会话是随机的
 * 32 位十六进制 id，带过期时间并持久化——重启控制台不会把已登录的人踢下线。
 *
 * 出厂凭据是 `harness` / `harness`（登录框下方也有提示），并且带一个 `mustChange` 标记：
 * 用它登录后**必须**先改成自己的账号密码（≥6 位、同时含大小写字母与数字），
 * 改完所有会话作废、必须重新登录，之后才能真正进入控制台。
 *
 * 也可以用 `scripts/set-password.sh <用户名> <密码>` 直接改，
 * 或用环境变量 `QQBOT_AUTH_USER` / `QQBOT_AUTH_PASSWORD` 覆盖（容器化部署用）。
 *
 * @module dashboard/auth
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 出厂账号：登录框下方会提示它，且必须在首次登录后修改。 */
export const DEFAULT_USERNAME = 'harness'
export const DEFAULT_PASSWORD = 'harness'

/** 密码规则：不少于 6 位，且同时包含大写字母、小写字母与数字。 */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) return '密码不得少于 6 个字符'
  if (!/[A-Z]/.test(password)) return '密码必须包含至少一个大写字母'
  if (!/[a-z]/.test(password)) return '密码必须包含至少一个小写字母'
  if (!/[0-9]/.test(password)) return '密码必须包含至少一个数字'
  return undefined
}

/** 会话有效期：30 天。 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** scrypt 参数与派生长度。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/** 生成一个便于口头转述但足够强的密码（去掉易混字符）。 */
/** 生成一个便于口头转述但足够强的密码（仅在调用方显式要求时使用）。 */
function generatePassword(length = 16) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** 派生密码哈希。 */
function derive(password, salt) {
  return scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex')
}

/** 原子写。 */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
}

/**
 * 账号存储：一个文件里的用户、密码哈希与会话表。
 */
export class AuthStore {
  #file
  #logger
  #state

  /**
   * @param options.file - `runtime/dashboard.auth.json` 的绝对路径。
   * @param options.username - 首次创建时使用的用户名（默认 `harness`）。
   * @param options.password - 首次创建时使用的密码（默认 `harness`，且会被标记为必须修改）。
   * @param options.logger - 用于打印一次性提示。
   */
  constructor(options) {
    this.#file = options.file
    this.#logger = options.logger
    this.#state = this.#load(options.username, options.password)
    this.#sweep()
  }

  #load(username, password) {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
      if (typeof parsed?.username === 'string' && typeof parsed?.hash === 'string' && typeof parsed?.salt === 'string') {
        return {
          username: parsed.username,
          salt: parsed.salt,
          hash: parsed.hash,
          // 老文件没有这个字段：只有在用的还是出厂用户名时才要求改
          mustChange: typeof parsed.mustChange === 'boolean' ? parsed.mustChange : parsed.username === DEFAULT_USERNAME,
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
        }
      }
    } catch {
      /* 首次运行或文件损坏：重建 */
    }
    const user = typeof username === 'string' && username.trim() !== '' ? username.trim() : DEFAULT_USERNAME
    const secret = typeof password === 'string' && password !== '' ? password : DEFAULT_PASSWORD
    const salt = randomBytes(16).toString('hex')
    // 出厂凭据（或运维显式预设的初始凭据）一律要求首次登录后修改
    const state = { username: user, salt, hash: derive(secret, salt), mustChange: true, sessions: [] }
    writeAtomic(this.#file, `${JSON.stringify(state, null, 2)}\n`)
    this.#logger?.warn?.(
      `控制台出厂账号：${user} / ${secret}（首次登录后必须修改；也可用 scripts/set-password.sh 预设）`
    )
    return state
  }

  /** 当前用户名。 */
  get username() {
    return this.#state.username
  }

  /** 是否还停留在"必须先改账号密码"的状态。 */
  get mustChange() {
    return this.#state.mustChange === true
  }

  /** 丢弃已过期的会话。 */
  #sweep() {
    const now = Date.now()
    const kept = this.#state.sessions.filter((session) => typeof session?.expiresAt === 'number' && session.expiresAt > now)
    if (kept.length !== this.#state.sessions.length) {
      this.#state.sessions = kept
      this.#persist()
    }
  }

  #persist() {
    writeAtomic(this.#file, `${JSON.stringify(this.#state, null, 2)}\n`)
  }

  /**
   * 校验用户名与密码。
   * @returns 通过与否（用户名错误与密码错误耗时一致，不泄漏是哪一项）。
   */
  verify(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string') return false
    const expectedUser = Buffer.from(this.#state.username)
    const suppliedUser = Buffer.from(username.trim())
    const userOk = expectedUser.length === suppliedUser.length && timingSafeEqual(expectedUser, suppliedUser)
    const expected = Buffer.from(this.#state.hash, 'hex')
    const supplied = Buffer.from(derive(password, this.#state.salt), 'hex')
    const passOk = expected.length === supplied.length && timingSafeEqual(expected, supplied)
    return userOk && passOk
  }

  /** 新建一个会话，返回会话 id 与过期时间。 */
  createSession() {
    this.#sweep()
    const id = randomBytes(16).toString('hex')
    const expiresAt = Date.now() + SESSION_TTL_MS
    this.#state.sessions.push({ id, createdAt: Date.now(), expiresAt, mustChange: this.mustChange })
    if (this.#state.sessions.length > 50) this.#state.sessions = this.#state.sessions.slice(-50)
    this.#persist()
    return { id, expiresAt }
  }

  /** 会话是否有效。 */
  hasSession(id) {
    return this.session(id) !== undefined
  }

  /** 取一个有效会话（带它建立时的 mustChange 快照）。 */
  session(id) {
    if (typeof id !== 'string' || id === '') return undefined
    const hit = this.#state.sessions.find((session) => session.id === id)
    if (hit === undefined || hit.expiresAt <= Date.now()) return undefined
    return hit
  }

  /** 这个会话是否仍需先改凭据。 */
  sessionMustChange(id) {
    const hit = this.session(id)
    if (hit === undefined) return this.mustChange
    return hit.mustChange === true || this.mustChange
  }

  /** 注销一个会话。 */
  dropSession(id) {
    const before = this.#state.sessions.length
    this.#state.sessions = this.#state.sessions.filter((session) => session.id !== id)
    if (this.#state.sessions.length !== before) this.#persist()
  }

  /** 注销所有会话（改密码时调用）。 */
  dropAllSessions() {
    if (this.#state.sessions.length === 0) return
    this.#state.sessions = []
    this.#persist()
  }

  /**
   * 用户主动修改账号密码（首次登录的强制修改也走这里）。
   *
   * 校验当前密码 → 校验新密码规则 → 落盘 → **作废所有会话**（改完必须重新登录）。
   * @returns 新的用户名。
   */
  changeCredential(input) {
    const current = typeof input?.currentPassword === 'string' ? input.currentPassword : ''
    if (!this.verify(this.#state.username, current)) throw new Error('当前密码不正确')
    const user = typeof input?.username === 'string' && input.username.trim() !== '' ? input.username.trim() : this.#state.username
    const problem = validatePassword(input?.password)
    if (problem !== undefined) throw new Error(problem)
    if (input.password === DEFAULT_PASSWORD) throw new Error('新密码不能与出厂密码相同')
    const salt = randomBytes(16).toString('hex')
    this.#state = { username: user, salt, hash: derive(input.password, salt), mustChange: false, sessions: [] }
    this.#persist()
    return user
  }

  /** 直接重设用户名与密码（运维脚本用），同样作废所有会话。 */
  setCredential(username, password) {
    const user = typeof username === 'string' && username.trim() !== '' ? username.trim() : this.#state.username
    const problem = validatePassword(password)
    if (problem !== undefined) throw new Error(problem)
    const salt = randomBytes(16).toString('hex')
    this.#state = { username: user, salt, hash: derive(password, salt), mustChange: false, sessions: [] }
    this.#persist()
    return user
  }
}
