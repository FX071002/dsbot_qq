/**
 * Operator-facing side channel.
 *
 * The Host's own logger writes to whatever launched `dsh web`, which is not
 * always reachable when the bridge misbehaves. This module mirrors the same
 * facts into two files inside the deployment's working directory:
 *
 * - a JSON status document overwritten on every interesting transition, so
 *   `cat qqbot-status.json` answers "is the bridge up, and what did it last do";
 * - an append-only log line per event, size-capped so it cannot grow forever.
 *
 * Every write is best-effort: a failing side channel must never break the
 * bridge.
 *
 * @module @local/dsh-qqbot/status
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Rotate the append log once it exceeds this size. */
const LOG_MAX_BYTES = 1_048_576

/** Bytes kept after a rotation. */
const LOG_KEEP_BYTES = 262_144

/** One status document plus one append log, both optional. */
export class SideChannel {
  #statusFile
  #logFile
  #state
  #logger

  /**
   * @param options - target paths and a fallback logger.
   */
  constructor(options) {
    this.#statusFile = options.statusFile ?? ''
    this.#logFile = options.logFile ?? ''
    this.#logger = options.logger
    this.#state = {
      plugin: '@local/dsh-qqbot',
      build: options.build ?? 'unknown',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      state: 'starting',
      bot: null,
      gatewaySessionId: null,
      lastSeq: null,
      counters: { inbound: 0, replied: 0, failed: 0, rejected: 0, reconnects: 0 },
      lastInbound: null,
      lastReply: null,
      lastError: null
    }
  }

  /** The in-memory status document. */
  get state() {
    return this.#state
  }

  /**
   * Merge one patch into the status document and rewrite it.
   * @param patch - shallow top-level fields to merge.
   */
  write(patch) {
    Object.assign(this.#state, patch)
    this.#state.updatedAt = new Date().toISOString()
    if (this.#statusFile === '') return
    try {
      mkdirSync(dirname(this.#statusFile), { recursive: true })
      const temporary = `${this.#statusFile}.tmp`
      writeFileSync(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.#statusFile)
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 写入状态文件失败：${error?.message ?? String(error)}`)
    }
  }

  /**
   * Append one line to the side log (and, when it is an error, to the Host log).
   * @param level - `info`, `warn`, or `error`.
   * @param message - the line to record.
   */
  line(level, message) {
    const stamp = new Date().toISOString()
    const rendered = `${stamp} [${level}] ${message}\n`
    if (level === 'error') this.#logger?.error?.(`qqbot: ${message}`)
    else if (level === 'warn') this.#logger?.warn?.(`qqbot: ${message}`)
    if (this.#logFile === '') return
    try {
      mkdirSync(dirname(this.#logFile), { recursive: true })
      this.#rotate()
      appendFileSync(this.#logFile, rendered, { mode: 0o600 })
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 写入日志文件失败：${error?.message ?? String(error)}`)
    }
  }

  #rotate() {
    try {
      const size = statSync(this.#logFile).size
      if (size <= LOG_MAX_BYTES) return
      const tail = readFileSync(this.#logFile).subarray(-LOG_KEEP_BYTES)
      writeFileSync(this.#logFile, tail, { mode: 0o600 })
    } catch {
      /* the file does not exist yet, or the rotation is not worth failing over */
    }
  }
}
