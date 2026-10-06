/**
 * The Harness side of the bridge: one Agent-backed Session per QQ conversation.
 *
 * Sessions are created and driven through the same `sessionController` service
 * the Web UI uses, so a conversation held over QQ is an ordinary Harness
 * Session: it is persisted, it carries the profile's default model, preset, and
 * tools, and it appears in the Web UI's session list.
 *
 * @module @local/dsh-qqbot/bridge
 */

import { createHash, randomUUID } from 'node:crypto'

/** Extract the visible text of one assistant message. */
function assistantText(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * Read the assistant output a Session produced after `fromSeq`.
 * @param session - live Session whose log is the source of truth.
 * @param fromSeq - first sequence number belonging to this exchange.
 * @returns the reply text plus the failure of the last finished turn, if any.
 */
export function collectReply(session, fromSeq) {
  const parts = []
  let failure
  for (const event of session.snapshotEvents(fromSeq)) {
    if (event.type === 'assistant/message') {
      const text = assistantText(event.data?.message)
      if (text !== '') parts.push(text)
      continue
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason
      if (reason?.kind === 'error') failure = reason.error?.message ?? '模型请求失败'
      else if (reason?.kind === 'aborted') failure = '本轮被中断'
      else if (reason?.kind === 'max-tokens') failure = '输出达到长度上限'
      else failure = undefined
    }
  }
  return { text: parts.join('\n\n'), failure }
}

/**
 * One queue of Agent turns per QQ conversation.
 */
export class SessionBridge {
  #ctx
  #config
  #logger
  #tails = new Map()

  /**
   * @param options - harness context, normalized config, and diagnostics.
   */
  constructor(options) {
    this.#ctx = options.ctx
    this.#config = options.config
    this.#logger = options.logger
  }

  /**
   * Derive the stable Session identity for one QQ conversation.
   * @param target - `{ scene, openid }`.
   * @returns a Harness Session id that survives restarts.
   */
  sessionIdFor(target) {
    // The `r2` epoch is part of the identity: an Agent scope carries persona
    // and capability registrations that cannot be revoked from outside, so a
    // schema change that must not inherit them gets a fresh identity instead.
    const digest = createHash('sha256').update(`r2:${target.scene}:${target.openid}`).digest('hex').slice(0, 16)
    return `${this.#config.sessionPrefix}${target.scene}-r2-${digest}`
  }

  /**
   * Run one QQ message through its conversation's Agent.
   *
   * Messages for the same conversation are serialized: a second message queues
   * behind the first instead of interleaving two turns.
   *
   * @param target - `{ scene, openid }` naming the conversation.
   * @param text - the prompt text to deliver.
   * @returns the reply text, a failure summary, and whether the wait timed out.
   */
  run(target, text) {
    const sessionId = this.sessionIdFor(target)
    return this.#enqueue(sessionId, () => this.#runTurn(sessionId, text))
  }

  #enqueue(key, task) {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const next = previous.then(task, task)
    const tail = next.then(
      () => {},
      () => {}
    )
    this.#tails.set(key, tail)
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return next
  }

  async #runTurn(sessionId, text) {
    const agent = await this.#ensureAgent(sessionId)
    const startSeq = agent.session.seq
    // `sessionController` is a Remote facade: `prompt` dereferences the caller's
    // AbortSignal, so an in-process caller must supply one. It guards admission
    // only, so a signal that is never aborted leaves the turn itself intact.
    const admission = new AbortController()
    await this.#ctx.sessionController.prompt(
      {
        sessionId,
        requestId: `qq-${randomUUID()}`,
        mode: 'queue',
        content: [{ type: 'text', text }]
      },
      admission.signal
    )

    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#config.turnTimeoutMs)
      timer.unref?.()
    })
    let outcome
    try {
      outcome = await Promise.race([agent.whenIdle().then(() => 'idle'), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    // The checkpoint policy flushes at step boundaries, so the final step of a
    // turn can still be buffered when the turn ends. A chat bridge answers a
    // conversation that must outlive a crash right after the reply, so flush
    // explicitly, exactly as the one-shot runner does.
    try {
      await this.#ctx.get('sessions')?.flush(agent.session)
    } catch (error) {
      this.#logger?.warn?.(`qqbot: 会话 ${sessionId} 落盘失败：${error?.message ?? String(error)}`)
    }

    const collected = collectReply(agent.session, startSeq)
    return { ...collected, sessionId, timedOut: outcome === 'timeout' }
  }

  async #ensureAgent(sessionId) {
    const controller = this.#ctx.sessionController
    let creationError
    try {
      await controller.create({ sessionId, cwd: this.#config.sessionCwd })
    } catch (error) {
      // A persisted Session keeps the cwd it was created with; adopting it
      // still works even when the configured directory has since changed.
      creationError = error
      this.#logger?.warn?.(`qqbot: 创建/接管会话 ${sessionId} 失败，尝试直接恢复：${error?.message ?? String(error)}`)
    }

    const found = await controller.resolveAgent(sessionId)
    if (found?.agent !== undefined) return found.agent
    throw creationError ?? new Error(found?.error?.message ?? `无法解析会话 ${sessionId}`)
  }
}
