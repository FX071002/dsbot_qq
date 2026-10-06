/**
 * Dashboard core: filesystem-backed state shared with the bridge plugin.
 *
 * The dashboard owns nothing the bridge needs at runtime except two files it
 * writes — the runtime document and a control request — so the two processes
 * stay decoupled and either can restart alone.
 *
 * @module dashboard/core
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  IMAGE_PROVIDER_PRESETS,
  PERSONA_PRESETS,
  RUNTIME_VERSION,
  defaultRuntimeConfig,
  normalizeRuntimeConfig
} from '../../shared/runtime.js'
import { loadPlugins, removePlugin, writePlugin } from '../../shared/plugins.js'
import { AuthStore } from './auth.js'
import { generateImage } from '../../shared/image.js'

const run = promisify(execFile)

/** Dashboard version, surfaced in the UI footer. */
export const VERSION = '1.0.0'

/** Absolute paths this deployment uses. */
export function resolvePaths(home, codeDir) {
  const root = resolve(home)
  // 代码与数据可能不在同一层（容器镜像里代码在 /app、数据在卷里），
  // 所以前端与内置插件跟着**这份代码**走，只有运行时文件跟 home 走。
  const code = resolve(codeDir ?? root)
  const runtimeDir = join(root, 'runtime')
  return {
    home: root,
    codeDir: code,
    runtimeDir,
    pluginsDir: join(root, 'plugins'),
    mediaDir: join(runtimeDir, 'media'),
    builtinDir: join(code, 'builtin-plugins'),
    publicDir: join(code, 'public'),
    configFile: join(runtimeDir, 'qqbot.config.json'),
    catalogFile: join(runtimeDir, 'model-catalog.json'),
    controlFile: join(runtimeDir, 'control.json'),
    controlResultFile: join(runtimeDir, 'control-result.json'),
    reloadFile: join(runtimeDir, 'reload.request'),
    statusFile: join(root, 'qqbot-status.json'),
    logFile: join(root, 'qqbot.log'),
    authFile: join(runtimeDir, 'dashboard.auth.json')
  }
}

/** Write a file atomically (the bridge watches these paths). */
function writeAtomic(file, content, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, content, { mode })
  renameSync(temporary, file)
}

/** Read and normalize the runtime document, seeding defaults once. */
export function readRuntime(paths) {
  try {
    return normalizeRuntimeConfig(JSON.parse(readFileSync(paths.configFile, 'utf8')))
  } catch {
    const seeded = defaultRuntimeConfig()
    writeRuntime(paths, seeded, seeded.revision)
    // Re-read so the caller sees the same revision the file now carries.
    return normalizeRuntimeConfig(JSON.parse(readFileSync(paths.configFile, 'utf8')))
  }
}

/**
 * Persist a runtime document with optimistic concurrency.
 * @returns the new revision.
 * @throws when the caller's revision is stale.
 */
export function writeRuntime(paths, config, expectedRevision) {
  const current = (() => {
    try {
      return normalizeRuntimeConfig(JSON.parse(readFileSync(paths.configFile, 'utf8')))
    } catch {
      return defaultRuntimeConfig()
    }
  })()
  if (Number.isFinite(Number(expectedRevision)) && Number(expectedRevision) !== current.revision) {
    const error = new Error('配置已被其他地方修改，请刷新后重试')
    error.statusCode = 409
    throw error
  }
  const next = normalizeRuntimeConfig({
    ...config,
    version: RUNTIME_VERSION,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString()
  })
  writeAtomic(paths.configFile, `${JSON.stringify(next, null, 2)}\n`)
  return next.revision
}

/** Read the bridge's published status document. */
export function readStatus(paths) {
  try {
    return JSON.parse(readFileSync(paths.statusFile, 'utf8'))
  } catch {
    return null
  }
}

/** Read the model catalog the bridge publishes for the dashboard's dropdowns. */
export function readCatalog(paths) {
  try {
    return JSON.parse(readFileSync(paths.catalogFile, 'utf8'))
  } catch {
    return { providers: [], current: null, updatedAt: null }
  }
}

/** Read the tail of the bridge log, parsed into level-tagged lines. */
export function readLog(paths, lines = 300) {
  let text = ''
  let bytes = 0
  try {
    bytes = statSync(paths.logFile).size
    if (bytes <= 3_000_000) {
      text = readFileSync(paths.logFile, 'utf8')
    } else {
      const whole = readFileSync(paths.logFile)
      text = whole.subarray(Math.max(0, whole.length - 1_000_000)).toString('utf8')
      text = text.slice(text.indexOf('\n') + 1)
    }
  } catch {
    return { lines: [], path: paths.logFile, bytes: 0 }
  }
  const parsed = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const match = /^(\S+)\s+\[(\w+)\]\s*([\s\S]*)$/.exec(raw)
    if (match === null) parsed.push({ time: null, level: 'raw', text: raw })
    else parsed.push({ time: match[1], level: match[2], text: match[3] })
  }
  return { lines: parsed.slice(-Math.max(1, Math.min(5000, lines))), path: paths.logFile, bytes }
}

/** Truncate the bridge log. */
export function clearLog(paths) {
  try {
    writeFileSync(paths.logFile, '', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** Load (or create) the dashboard account store. */
export function openAuth(paths, logger) {
  return new AuthStore({
    file: paths.authFile,
    username: process.env.QQBOT_AUTH_USER,
    password: process.env.QQBOT_AUTH_PASSWORD,
    logger
  })
}

/** Builtin plugin manifests available for one-click install. */
export function readBuiltins(paths) {
  try {
    return readdirSync(paths.builtinDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          const manifest = JSON.parse(readFileSync(join(paths.builtinDir, entry.name, 'plugin.json'), 'utf8'))
          return {
            id: entry.name,
            name: typeof manifest.name === 'string' ? manifest.name : entry.name,
            version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
            description: typeof manifest.description === 'string' ? manifest.description : '',
            author: typeof manifest.author === 'string' ? manifest.author : 'builtin'
          }
        } catch {
          return null
        }
      })
      .filter((entry) => entry !== null)
  } catch {
    return []
  }
}

/** Every installed plugin, as the API reports it. */
export function listInstalled(paths) {
  return loadPlugins(paths.pluginsDir).map((plugin) => ({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    author: plugin.author,
    enabled: plugin.enabled,
    source: plugin.source ?? 'local',
    installedAt: plugin.installedAt ?? null,
    promptChars: typeof plugin.prompt === 'string' ? plugin.prompt.length : 0,
    prompt: typeof plugin.prompt === 'string' ? plugin.prompt : '',
    commands: plugin.commands.map((command) => ({ pattern: command.pattern, label: command.label })),
    error: plugin.error ?? null
  }))
}

/** Copy one builtin plugin into the live plugin directory. */
export function installBuiltin(paths, id) {
  const source = join(paths.builtinDir, id)
  if (!existsSync(join(source, 'plugin.json'))) throw new Error(`内置目录里没有插件「${id}」`)
  const manifest = JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8'))
  manifest.source = 'builtin'
  manifest.installedAt = new Date().toISOString()
  manifest.id = id
  writePlugin(paths.pluginsDir, id, manifest)
  return id
}

/** Copy a local directory into the plugin directory. */
export function installFromPath(paths, fromPath) {
  const source = resolve(fromPath)
  const manifestFile = join(source, 'plugin.json')
  if (!existsSync(manifestFile)) throw new Error(`${source} 下没有 plugin.json`)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const id = typeof manifest.id === 'string' && manifest.id !== '' ? manifest.id : basename(source)
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error(`非法的插件 id：${id}`)
  const target = join(paths.pluginsDir, id)
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  const stored = JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8'))
  stored.id = id
  stored.source = 'path'
  stored.installedAt = new Date().toISOString()
  writePlugin(paths.pluginsDir, id, stored)
  return id
}

/** Download a tar.gz plugin archive and install it. */
export async function installFromUrl(paths, url) {
  if (!/^https?:\/\//.test(url)) throw new Error('只支持 http(s) 链接')
  const workdir = mkdtempSync(join(tmpdir(), 'qqbot-plugin-'))
  try {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const archive = join(workdir, 'plugin.tar.gz')
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    const extracted = join(workdir, 'extracted')
    mkdirSync(extracted, { recursive: true })
    try {
      await run('tar', ['-xzf', archive, '-C', extracted])
    } catch (error) {
      throw new Error(`解压失败（需要 tar.gz）：${error?.message ?? String(error)}`)
    }
    const candidates = [extracted, ...readdirSync(extracted, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(extracted, e.name))]
    const root = candidates.find((candidate) => existsSync(join(candidate, 'plugin.json')))
    if (root === undefined) throw new Error('压缩包里没有找到 plugin.json')
    return installFromPath(paths, root)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

/** Enable or disable one installed plugin. */
export function setPluginEnabled(paths, id, enabled) {
  const file = join(paths.pluginsDir, id, 'plugin.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.enabled = enabled === true
  writePlugin(paths.pluginsDir, id, manifest)
}

/** Patch the editable fields of one installed plugin. */
export function updatePlugin(paths, id, patch) {
  const file = join(paths.pluginsDir, id, 'plugin.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  for (const key of ['name', 'description', 'prompt']) {
    if (typeof patch?.[key] === 'string') manifest[key] = patch[key]
  }
  if (typeof patch?.enabled === 'boolean') manifest.enabled = patch.enabled
  writePlugin(paths.pluginsDir, id, manifest)
}

/** Delete one installed plugin. */
export function deletePlugin(paths, id) {
  removePlugin(paths.pluginsDir, id)
}

/** First-run convenience: seed the builtin plugins when none are installed. */
export function seedPlugins(paths) {
  mkdirSync(paths.pluginsDir, { recursive: true })
  const existing = readdirSync(paths.pluginsDir).filter((name) => !name.startsWith('.'))
  if (existing.length > 0) return []
  const installed = []
  for (const builtin of readBuiltins(paths)) {
    try {
      installBuiltin(paths, builtin.id)
      installed.push(builtin.id)
    } catch {
      /* a broken builtin must not block startup */
    }
  }
  return installed
}

/** Write the marker that asks the bridge to re-import its implementation. */
export function requestCodeReload(paths) {
  writeAtomic(paths.reloadFile, `${new Date().toISOString()}\n`)
}

/**
 * Ask the bridge to perform one privileged action and wait for its answer.
 * @returns `{ ok, message }`.
 */
export async function control(paths, action, payload, timeoutMs = 30_000) {
  const id = randomUUID()
  writeAtomic(
    paths.controlFile,
    `${JSON.stringify({ id, action, ...(payload === undefined ? {} : { payload }), at: new Date().toISOString() })}\n`
  )
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200))
    try {
      const result = JSON.parse(readFileSync(paths.controlResultFile, 'utf8'))
      if (result?.id === id) {
        return { ok: result.ok === true, message: String(result.message ?? ''), payload: result.payload }
      }
    } catch {
      /* not written yet */
    }
  }
  return { ok: false, message: '桥接插件没有在 12 秒内响应（可能未加载或已停止）' }
}

/** Run one image generation through the configured provider. */
export async function testImage(paths, prompt, base = '') {
  const runtime = readRuntime(paths)
  const result = await generateImage(runtime.capabilities.image, prompt)
  if (result.ok !== true) return { ok: false, error: result.error }
  const publicBase = runtime.capabilities.image.publicBaseUrl.replace(/\/+$/, '')
  if (typeof result.url === 'string' && result.url !== '') {
    return { ok: true, url: result.url, bytes: 0, ms: result.ms }
  }
  if (typeof result.base64 === 'string') {
    const bytes = Buffer.from(result.base64, 'base64')
    const file = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.png`
    mkdirSync(paths.mediaDir, { recursive: true })
    writeFileSync(join(paths.mediaDir, file), bytes, { mode: 0o644 })
    return {
      ok: true,
      url: `${base}/media/${file}`,
      publicUrl: publicBase === '' ? null : `${publicBase}/media/${file}`,
      bytes: bytes.length,
      ms: result.ms
    }
  }
  return { ok: false, error: '生图接口没有返回可用图片' }
}

/** Append one line to a dashboard-side audit log. */
export function audit(paths, message) {
  try {
    mkdirSync(paths.runtimeDir, { recursive: true })
    appendFileSync(join(paths.runtimeDir, 'dashboard.log'), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 })
  } catch {
    /* auditing must never break a request */
  }
}

export { IMAGE_PROVIDER_PRESETS, PERSONA_PRESETS }
