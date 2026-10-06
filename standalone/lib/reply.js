/**
 * 独立模式：QQ 消息回复通道。
 *
 * 与 Harness 模式同规：优先被动回复（带 `msg_id` + 递增 `msg_seq`），窗口或次数用尽
 * 自动降级为主动消息；长文按段落切分成多条。
 *
 * @module standalone/reply
 */

/** 被动回复不可用的错误码（过期 / 超次 / msg_id 无效）。 */
const PASSIVE_UNAVAILABLE = new Set([40034005, 40034128, 40034024, 40034025, 40034026, 304103])

/** 各场景的被动回复次数与窗口。 */
const LIMITS = {
  group: { replies: 5, windowMs: 5 * 60_000 },
  c2c: { replies: 4, windowMs: 60 * 60_000 }
}

/** 把一段长文本切成 QQ 能接受的多条消息。 */
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
  if (rest !== '' && chunks.length > 0) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}\n\n…（内容较长，已截断）`
  return chunks.filter((chunk) => chunk !== '')
}

/**
 * 建一个发送器。
 * @param options.api - `QQApi` 实例。
 * @param options.limits - `{ maxChars, maxChunks }`。
 * @param options.logger - 诊断日志。
 * @returns `{ deliver, sendImage }`。
 */
export function createReplySender(options) {
  const { api, logger } = options
  const maxChars = options.limits?.maxChars ?? 1500
  const maxChunks = options.limits?.maxChunks ?? 4
  const seqs = new Map()

  function nextSeq(messageId) {
    const next = (seqs.get(messageId) ?? 0) + 1
    seqs.set(messageId, next)
    while (seqs.size > 500) {
      const oldest = seqs.keys().next()
      if (oldest.done === true) break
      seqs.delete(oldest.value)
    }
    return next
  }

  /** 发一条原始消息体，被动失败时降级为主动。 */
  async function sendBody(target, body, messageId) {
    const withPassive = messageId === undefined ? body : { ...body, msg_id: messageId, msg_seq: nextSeq(messageId) }
    try {
      return await api.sendMessage(target, withPassive)
    } catch (error) {
      const recoverable =
        messageId !== undefined && (PASSIVE_UNAVAILABLE.has(error?.code) || error?.code === 40054005)
      if (!recoverable) throw error
      logger?.warn?.(`被动回复不可用（code=${error.code}），改用主动消息`)
      const { msg_id: _id, msg_seq: _seq, ...active } = withPassive
      return await api.sendMessage(target, active)
    }
  }

  /**
   * 把一段回复发给某个会话。
   * @param target - `{ scene, openid }`。
   * @param messageId - 触发这条回复的 `msg_id`（没有则直接发主动消息）。
   * @param receivedAt - 收到消息的时间戳，用于判断被动窗口是否还开着。
   * @param text - 回复正文。
   */
  async function deliver(target, messageId, receivedAt, text) {
    const chunks = splitText(text, maxChars, maxChunks)
    if (chunks.length === 0) return
    const limit = LIMITS[target.scene] ?? LIMITS.c2c
    for (const chunk of chunks) {
      const used = seqs.get(messageId) ?? 0
      const passive = messageId !== undefined && Date.now() - receivedAt < limit.windowMs - 2000 && used < limit.replies
      await sendBody(target, { msg_type: 0, content: chunk }, passive ? messageId : undefined)
    }
  }

  /**
   * 上传并发送一张图片。
   * @param target - `{ scene, openid }`。
   * @param messageId - 被动回复锚点。
   * @param url - 图片的公网地址（QQ 需要能拉到）。
   */
  async function sendImage(target, messageId, url) {
    const path =
      target.scene === 'group'
        ? `/v2/groups/${encodeURIComponent(target.openid)}/files`
        : `/v2/users/${encodeURIComponent(target.openid)}/files`
    const uploaded = await api.call('POST', path, { body: { file_type: 1, url, srv_send_msg: false } })
    const fileInfo = uploaded?.file_info
    if (typeof fileInfo !== 'string' || fileInfo === '') throw new Error('上传图片后没有拿到 file_info')
    await sendBody(target, { msg_type: 7, media: { file_info: fileInfo } }, messageId)
  }

  return { deliver, sendBody, sendImage }
}
