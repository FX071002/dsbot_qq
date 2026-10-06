/**
 * Text-to-image support.
 *
 * Speaks the OpenAI images API and the two provider dialects the dashboard
 * offers as presets (硅基流动 returns `images[].url`, OpenAI and 智谱 return
 * `data[].url`/`data[].b64_json`). The caller decides how the resulting image
 * reaches QQ; this module only produces bytes or a public URL.
 *
 * @module @local/dsh-qqbot-core/image
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Longest image request the bridge will wait for. */
const IMAGE_TIMEOUT_MS = 120_000

/** Build the provider-specific request body. */
function requestBody(provider, options) {
  const { model, prompt, size } = options
  if (provider === 'siliconflow') {
    return { model, prompt, image_size: size, batch_size: 1 }
  }
  return { model, prompt, size, n: 1 }
}

/** Pick the first usable image out of either response dialect. */
function extractImage(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const candidates = []
  if (Array.isArray(payload.data)) candidates.push(...payload.data)
  if (Array.isArray(payload.images)) candidates.push(...payload.images)
  if (Array.isArray(payload.output)) candidates.push(...payload.output)
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.url === 'string' && candidate.url !== '') return { url: candidate.url }
    if (typeof candidate.b64_json === 'string' && candidate.b64_json !== '') return { base64: candidate.b64_json }
    if (typeof candidate.image_url === 'string' && candidate.image_url !== '') return { url: candidate.image_url }
  }
  if (typeof payload.url === 'string' && payload.url !== '') return { url: payload.url }
  return undefined
}

/**
 * Ask one image provider for a picture.
 * @param config - `capabilities.image` from the runtime document.
 * @param prompt - what to draw.
 * @param options - optional `size` override and cancellation.
 * @returns `{ ok: true, url?, base64?, ms }` or `{ ok: false, error, ms }`.
 */
export async function generateImage(config, prompt, options = {}) {
  const started = Date.now()
  if (config.apiKey.trim() === '') return { ok: false, error: '未配置生图服务：缺少 API Key', ms: 0 }
  if (config.baseUrl.trim() === '') return { ok: false, error: '未配置生图服务：缺少接口地址', ms: 0 }
  if (config.model.trim() === '') return { ok: false, error: '未配置生图服务：缺少模型名', ms: 0 }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/images/generations`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('生图请求超时')), IMAGE_TIMEOUT_MS)
  const forward = () => controller.abort(new Error('已取消'))
  options.signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(requestBody(config.provider, {
        model: config.model,
        prompt,
        size: options.size ?? config.size
      })),
      signal: controller.signal
    })
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return { ok: false, error: `生图接口返回了非 JSON（HTTP ${response.status}）`, ms: Date.now() - started }
    }
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.message ?? text.slice(0, 200)
      return { ok: false, error: `生图接口 HTTP ${response.status}：${detail}`, ms: Date.now() - started }
    }
    const image = extractImage(payload)
    if (image === undefined) return { ok: false, error: '生图接口没有返回图片字段', ms: Date.now() - started }
    return { ok: true, ...image, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: `生图请求失败：${error?.message ?? String(error)}`, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forward)
  }
}

/**
 * Persist one image so the dashboard can serve it at a public URL.
 * @param mediaDir - absolute media directory.
 * @param bytes - image bytes.
 * @param contentType - response content type, used to pick the extension.
 * @returns `{ file, bytes }`.
 */
export function saveImage(mediaDir, bytes, contentType = '') {
  const extension = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png'
  const file = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${extension}`
  mkdirSync(mediaDir, { recursive: true })
  writeFileSync(join(mediaDir, file), bytes, { mode: 0o644 })
  return { file, bytes: bytes.length }
}

/**
 * Download a generated image so it can be re-served and re-uploaded reliably.
 * @param url - provider URL.
 * @param signal - cancellation.
 * @returns `{ bytes, contentType }` or throws.
 */
export async function downloadImage(url, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`下载生成的图片失败：HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error('下载生成的图片为空')
  return { bytes: buffer, contentType: response.headers.get('content-type') ?? '' }
}
