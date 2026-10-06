/**
 * Third-party plugin support for the QQ bridge.
 *
 * A plugin is one directory under `plugins/` holding a `plugin.json`. It may
 * contribute an extra persona paragraph (so the model knows the capability
 * exists) and any number of shortcut commands that answer without spending a
 * model call. Commands are matched against the raw QQ message text first, so a
 * `/ping` never reaches the Agent.
 *
 * @module @local/dsh-qqbot-core/plugins
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Largest plugin.json accepted. */
const MAX_MANIFEST_BYTES = 262_144

/** Default truncation for one command reply. */
const DEFAULT_REPLY_LIMIT = 800

/** Longest shortcut command the bridge will run. */
const COMMAND_TIMEOUT_MS = 15_000

/** Read and parse one plugin manifest, returning a diagnostics-carrying record. */
function readManifest(dir, id) {
  const file = join(dir, 'plugin.json')
  let raw
  try {
    const info = statSync(file)
    if (!info.isFile()) throw new Error('plugin.json 不是文件')
    if (info.size > MAX_MANIFEST_BYTES) throw new Error('plugin.json 过大')
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { id, name: id, version: '0.0.0', description: '', author: '', enabled: false, error: `读取失败：${error.message}`, commands: [], prompt: '' }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { id, name: id, version: '0.0.0', description: '', author: '', enabled: false, error: 'plugin.json 必须是对象', commands: [], prompt: '' }
  }

  const commands = []
  let commandError
  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) commandError = 'commands 必须是数组'
    else {
      for (const [index, entry] of raw.commands.entries()) {
        if (entry === null || typeof entry !== 'object') { commandError = `commands[${index}] 必须是对象`; break }
        if (typeof entry.pattern !== 'string' || entry.pattern === '') { commandError = `commands[${index}].pattern 必填`; break }
        try {
          // Compiled once here: an invalid pattern must fail at load, not at message time.
          new RegExp(entry.pattern, 'i')
        } catch (error) {
          commandError = `commands[${index}].pattern 不是合法正则：${error.message}`
          break
        }
        const http = entry.http !== null && typeof entry.http === 'object' ? entry.http : undefined
        if (http !== undefined && typeof http.url !== 'string') { commandError = `commands[${index}].http.url 必填`; break }
        commands.push({
          label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.pattern,
          pattern: entry.pattern,
          template: typeof entry.template === 'string' ? entry.template : '{{body}}',
          maxChars: Number.isFinite(Number(entry.maxChars)) ? Math.min(4000, Math.max(50, Math.trunc(Number(entry.maxChars)))) : DEFAULT_REPLY_LIMIT,
          ...(http === undefined ? {} : {
            http: {
              url: http.url,
              method: typeof http.method === 'string' ? http.method.toUpperCase() : 'GET',
              headers: http.headers !== null && typeof http.headers === 'object' ? http.headers : {},
              body: typeof http.body === 'string' ? http.body : undefined,
              timeoutMs: Number.isFinite(Number(http.timeoutMs)) ? Math.min(COMMAND_TIMEOUT_MS, Math.max(500, Math.trunc(Number(http.timeoutMs)))) : 8000
            }
          })
        })
      }
    }
  }

  return {
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    description: typeof raw.description === 'string' ? raw.description : '',
    author: typeof raw.author === 'string' ? raw.author : '',
    enabled: raw.enabled !== false,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    commands,
    source: typeof raw.source === 'string' ? raw.source : 'local',
    installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : null,
    error: commandError
  }
}

/**
 * Scan the plugin directory.
 * @param pluginsDir - absolute plugin root.
 * @returns every readable plugin record, sorted by name.
 */
export function loadPlugins(pluginsDir) {
  let entries
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(pluginsDir, entry.name)
    const manifest = join(dir, 'plugin.json')
    try {
      if (!statSync(manifest).isFile()) continue
    } catch {
      continue
    }
    plugins.push(readManifest(dir, entry.name))
  }
  return plugins.sort((left, right) => left.id.localeCompare(right.id))
}

/** Substitute `{1}`, `{2}`… capture groups into a string. */
function substituteGroups(text, match) {
  return text.replace(/\{(\d+)\}/g, (whole, index) => {
    const value = match[Number(index)]
    return value === undefined ? whole : value
  })
}

/** Substitute `{{body}}` and `{{1}}`… into a reply template. */
function renderTemplate(template, match, body) {
  return template
    .replace(/\{\{body\}\}/g, body)
    .replace(/\{\{(\d+)\}\}/g, (whole, index) => {
      const value = match[Number(index)]
      return value === undefined ? whole : value
    })
}

/** Keep one reply inside the QQ single-message budget. */
function clampReply(text, maxChars) {
  const trimmed = String(text ?? '').trim()
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars - 1)}…`
}

/**
 * Match one inbound message against every enabled plugin command.
 * @param plugins - loaded plugin records.
 * @param text - raw message text.
 * @returns the matched plugin, command and regex match, or `undefined`.
 */
export function matchCommand(plugins, text) {
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.error !== undefined) continue
    for (const command of plugin.commands) {
      const match = new RegExp(command.pattern, 'i').exec(text)
      if (match !== null) return { plugin, command, match }
    }
  }
  return undefined
}

/**
 * Produce the reply for one matched command, running its HTTP call if declared.
 * @param hit - result of {@link matchCommand}.
 * @param signal - cancellation for the outbound request.
 * @returns the reply text.
 */
export async function runCommand(hit, signal) {
  const { command, match } = hit
  if (command.http === undefined) return clampReply(renderTemplate(command.template, match, ''), command.maxChars)

  const url = substituteGroups(command.http.url, match)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('插件请求超时')), command.http.timeoutMs)
  const abort = () => controller.abort(new Error('已取消'))
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(url, {
      method: command.http.method,
      headers: { accept: '*/*', ...command.http.headers },
      body: command.http.body === undefined ? undefined : substituteGroups(command.http.body, match),
      signal: controller.signal
    })
    const body = (await response.text()).trim()
    if (!response.ok) {
      return clampReply(`插件「${hit.plugin.name}」请求失败：HTTP ${response.status}\n${body.slice(0, 300)}`, command.maxChars)
    }
    return clampReply(renderTemplate(command.template, match, body), command.maxChars)
  } catch (error) {
    return clampReply(`插件「${hit.plugin.name}」请求出错：${error?.message ?? String(error)}`, command.maxChars)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Write one plugin manifest, creating its directory.
 * @param pluginsDir - absolute plugin root.
 * @param id - directory name / plugin id.
 * @param manifest - complete manifest object.
 */
export function writePlugin(pluginsDir, id, manifest) {
  const dir = join(pluginsDir, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return dir
}

/**
 * Remove one plugin directory.
 * @param pluginsDir - absolute plugin root.
 * @param id - plugin id to delete.
 */
export function removePlugin(pluginsDir, id) {
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) throw new Error('非法的插件 id')
  rmSync(join(pluginsDir, id), { recursive: true, force: true })
}
