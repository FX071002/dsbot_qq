#!/usr/bin/env node
/**
 * 大肥鱼的QQ机器人服务 —— dashboard HTTP service.
 *
 * Zero-dependency Node server: it serves the single-page console plus the JSON
 * API that edits the runtime document, manages plugins, relays privileged
 * actions to the in-Host bridge plugin, and publishes generated media on a
 * public `/media` route so QQ can fetch images.
 *
 * Usage: node server.js [--home=/data/dsh/home/dfy-qqbot] [--host=0.0.0.0] [--port=9999]
 *
 * @module dashboard/server
 */

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { networkInterfaces, hostname, platform, totalmem, freemem, uptime } from 'node:os'

import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_FORMATS,
  addFile,
  addFolder,
  readEntryText,
  readIndex,
  removeEntry,
  resolveKnowledgePaths,
  search as searchKnowledge,
  statsOf,
  writeIndex
} from '../shared/knowledge.js'

import {
  IMAGE_PROVIDER_PRESETS,
  PERSONA_PRESETS,
  VERSION,
  audit,
  clearLog,
  control,
  deletePlugin,
  installBuiltin,
  installFromPath,
  installFromUrl,
  listInstalled,
  readBuiltins,
  readCatalog,
  readLog,
  readRuntime,
  readStatus,
  openAuth,
  requestCodeReload,
  resolvePaths,
  seedPlugins,
  setPluginEnabled,
  testImage,
  updatePlugin,
  writeRuntime
} from './lib/core.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find((entry) => entry.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const HOME = flag('home', process.env.QQBOT_HOME ?? '/data/dsh/home/dfy-qqbot')
const HOST = flag('host', '0.0.0.0')
const PORT = Number(flag('port', process.env.QQBOT_PORT ?? '9999'))
// When the console is reverse-proxied under a path prefix, its assets and API
// calls must carry that prefix: the browser resolves them from the origin root.
const RAW_BASE = flag('base', process.env.QQBOT_BASE ?? '')
const BASE =
  RAW_BASE === '' || RAW_BASE === '/' ? '' : `/${RAW_BASE.replace(/^\/+|\/+$/g, '')}`
const paths = resolvePaths(HOME, dirname(fileURLToPath(import.meta.url)))
const kbPaths = resolveKnowledgePaths(HOME)
const COOKIE = 'qqbot_session'
const auth = openAuth(paths, {
  warn: (message) => console.warn(`[dashboard] ${message}`)
})

/** Content types for the handful of asset kinds the console ships. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

function sendFile(response, file, { cache = false } = {}) {
  let info
  try {
    info = statSync(file)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    sendJson(response, 404, { error: 'not found' })
    return
  }
  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const headers = { 'content-type': type, 'content-length': info.size }
  headers['cache-control'] = cache ? 'public, max-age=300' : 'no-cache'
  response.writeHead(200, headers)
  response.end(readFileSync(file))
}

/** Serve the SPA shell with the console's mount prefix baked in. */
function sendIndex(response) {
  let html
  try {
    html = readFileSync(join(paths.publicDir, 'index.html'), 'utf8')
  } catch (error) {
    return sendJson(response, 500, { error: `控制台前端缺失：${error?.message ?? String(error)}` })
  }
  const rendered = html
    .replace(/(href|src)="\/(style\.css|app\.js)"/g, `$1="${BASE}/$2"`)
    .replace('</head>', `<script>window.__QQBOT_BASE__=${JSON.stringify(BASE)}</script></head>`)
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  response.end(rendered)
}

/** 读原始请求体（文件上传用），返回 Buffer。 */
function readBinary(request, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error(`文件超过 ${(limit / 1024 / 1024).toFixed(0)} MB 上限`), { statusCode: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function readBody(request, limit = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }))
      }
    })
    request.on('error', reject)
  })
}

function cookiesOf(request) {
  const header = request.headers.cookie ?? ''
  const jar = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return jar
}

const sessionOf = (request) => cookiesOf(request)[COOKIE] ?? ''
const authed = (request) => auth.hasSession(sessionOf(request))

/** Assemble the overview payload the landing page renders. */
function overview() {
  const status = readStatus(paths) ?? {}
  const runtime = readRuntime(paths)
  const installed = listInstalled(paths)
  const catalog = readCatalog(paths)
  const log = (() => {
    try {
      return { path: paths.logFile, bytes: statSync(paths.logFile).size }
    } catch {
      return { path: paths.logFile, bytes: 0 }
    }
  })()

  return {
    bridge: {
      state: status.state ?? 'unknown',
      build: status.build ?? null,
      bot: status.bot ?? null,
      gateway: status.gateway ?? null,
      counters: status.counters ?? { inbound: 0, replied: 0, failed: 0, rejected: 0 },
      lastInbound: status.lastInbound ?? null,
      lastReply: status.lastReply ?? null,
      lastError: status.lastError ?? null,
      startedAt: status.startedAt ?? null,
      updatedAt: status.updatedAt ?? null,
      runtime: status.runtime ?? {
        revision: runtime.revision,
        personaName: runtime.persona.name,
        capabilities: {
          tools: runtime.capabilities.tools,
          web: runtime.capabilities.web,
          image: runtime.capabilities.image.enabled
        },
        plugins: { total: installed.length, enabled: installed.filter((plugin) => plugin.enabled).length },
        tools: [],
        model: { ...runtime.models.chat }
      }
    },
    system: {
      hostname: hostname(),
      platform: `${platform()} ${process.arch}`,
      node: process.version,
      uptimeSec: Math.round(uptime()),
      memUsedMB: Math.round((totalmem() - freemem()) / 1048576),
      memTotalMB: Math.round(totalmem() / 1048576),
      publicBaseUrl: runtime.capabilities.image.publicBaseUrl,
      dashboard: VERSION,
      catalogUpdatedAt: catalog.updatedAt ?? null,
      addresses: Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
        .map((entry) => entry.address)
    },
    plugins: { installed: installed.length, enabled: installed.filter((plugin) => plugin.enabled).length },
    log
  }
}

/** Route table: exact paths and one `:id` pattern per mutating plugin route. */
async function route(request, response, url) {
  const { pathname } = url
  const method = request.method ?? 'GET'

  if (pathname === '/api/session' && method === 'GET') {
    const signedIn = authed(request)
    return sendJson(response, 200, {
      authed: signedIn,
      username: signedIn ? auth.username : null,
      // 出厂凭据登录后必须先改账号密码，改完还要重新登录
      mustChange: signedIn ? auth.sessionMustChange(sessionOf(request)) : auth.mustChange,
      version: VERSION
    })
  }
  if (pathname === '/api/login' && method === 'POST') {
    const body = await readBody(request)
    const username = typeof body.username === 'string' ? body.username : ''
    const password = typeof body.password === 'string' ? body.password : ''
    if (!auth.verify(username, password)) {
      audit(paths, `login failed for "${username.slice(0, 32)}"`)
      return sendJson(response, 401, { error: '用户名或密码不正确' })
    }
    const session = auth.createSession()
    const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000)
    response.setHeader(
      'set-cookie',
      `${COOKIE}=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`
    )
    audit(paths, `login ok for "${auth.username}"`)
    return sendJson(response, 200, { ok: true, username: auth.username, mustChange: auth.mustChange })
  }
  if (pathname === '/api/change-credentials' && method === 'POST') {
    const body = await readBody(request)
    if (!authed(request)) return sendJson(response, 401, { error: '未登录或登录已过期' })
    try {
      const username = auth.changeCredential({
        currentPassword: typeof body.currentPassword === 'string' ? body.currentPassword : '',
        username: typeof body.username === 'string' ? body.username : '',
        password: typeof body.password === 'string' ? body.password : ''
      })
      // 改完作废所有会话：必须用新账号重新登录
      response.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
      audit(paths, `credentials changed → "${username}"`)
      return sendJson(response, 200, { ok: true, username, relogin: true })
    } catch (error) {
      audit(paths, `credentials change rejected: ${error?.message ?? String(error)}`)
      return sendJson(response, 400, { error: error?.message ?? String(error) })
    }
  }
  if (pathname === '/api/logout' && method === 'POST') {
    auth.dropSession(sessionOf(request))
    response.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    return sendJson(response, 200, { ok: true })
  }

  if (pathname.startsWith('/api/') && !authed(request)) {
    return sendJson(response, 401, { error: '未登录或登录已过期' })
  }
  // 还在出厂凭据状态时，除了登录/登出/改密/会话查询，其余接口一律拒绝
  if (
    pathname.startsWith('/api/') &&
    !['/api/session', '/api/login', '/api/logout', '/api/change-credentials'].includes(pathname) &&
    auth.sessionMustChange(sessionOf(request))
  ) {
    return sendJson(response, 403, {
      error: '必须先修改默认账号密码',
      code: 'must_change_credentials'
    })
  }

  if (pathname === '/api/overview' && method === 'GET') return sendJson(response, 200, overview())

  if (pathname === '/api/config' && method === 'GET') {
    const runtime = readRuntime(paths)
    return sendJson(response, 200, { config: runtime, revision: runtime.revision, updatedAt: runtime.updatedAt })
  }
  if (pathname === '/api/config' && method === 'PUT') {
    const body = await readBody(request)
    const revision = writeRuntime(paths, body.config ?? {}, body.revision)
    audit(paths, `config saved → revision ${revision}`)
    return sendJson(response, 200, { ok: true, revision })
  }

  if (pathname === '/api/control' && method === 'POST') {
    const body = await readBody(request)
    const action = String(body.action ?? '')
    if (action === 'reload') {
      requestCodeReload(paths)
      audit(paths, 'code reload requested')
      return sendJson(response, 200, { ok: true, message: '已请求热重载桥接实现，几秒内生效' })
    }
    if (action === 'clear-log') {
      const ok = clearLog(paths)
      audit(paths, 'log cleared')
      return sendJson(response, 200, { ok, message: ok ? '日志已清空' : '日志清空失败' })
    }
    const bridged = {
      reconnect: 'reconnect',
      'test-connection': 'test-connection',
      'reload-config': 'reload-config',
      'test-model': 'test-model',
      'discover-models': 'discover-models',
      'test-harness': 'test-harness',
      'test-knowledge': 'test-knowledge'
    }
    if (bridged[action] !== undefined) {
      const result = await control(paths, bridged[action], body.payload)
      audit(paths, `control ${action} → ${result.ok ? 'ok' : 'fail'}: ${result.message}`)
      return sendJson(response, 200, {
        ok: result.ok,
        message: result.message,
        ...(result.payload === undefined ? {} : { payload: result.payload })
      })
    }
    return sendJson(response, 400, { error: `不支持的指令：${action || '(空)'}` })
  }

  if (pathname === '/api/plugins' && method === 'GET') {
    const installed = listInstalled(paths)
    const installedIds = new Set(installed.map((plugin) => plugin.id))
    const catalog = readBuiltins(paths).map((entry) => ({ ...entry, installed: installedIds.has(entry.id) }))
    return sendJson(response, 200, { installed, catalog })
  }
  if (pathname === '/api/plugins/install' && method === 'POST') {
    const body = await readBody(request)
    const source = String(body.source ?? '')
    let id
    if (source === 'catalog') id = installBuiltin(paths, String(body.id ?? ''))
    else if (source === 'path') id = installFromPath(paths, String(body.path ?? ''))
    else if (source === 'url') id = await installFromUrl(paths, String(body.url ?? ''))
    else return sendJson(response, 400, { error: `不支持的安装方式：${source || '(空)'}` })
    audit(paths, `plugin installed ${id} via ${source}`)
    return sendJson(response, 200, { ok: true, id, message: `插件「${id}」已安装` })
  }

  const pluginMatch = /^\/api\/plugins\/([^/]+)(?:\/(toggle))?$/.exec(pathname)
  if (pluginMatch !== null) {
    const id = decodeURIComponent(pluginMatch[1])
    const action = pluginMatch[2]
    if (action === 'toggle' && method === 'POST') {
      const body = await readBody(request)
      setPluginEnabled(paths, id, body.enabled === true)
      audit(paths, `plugin ${id} ${body.enabled === true ? 'enabled' : 'disabled'}`)
      return sendJson(response, 200, { ok: true })
    }
    if (method === 'PUT') {
      const body = await readBody(request)
      updatePlugin(paths, id, body.plugin ?? {})
      audit(paths, `plugin ${id} updated`)
      return sendJson(response, 200, { ok: true })
    }
    if (method === 'DELETE') {
      deletePlugin(paths, id)
      audit(paths, `plugin ${id} removed`)
      return sendJson(response, 200, { ok: true })
    }
  }

  if (pathname === '/api/models' && method === 'GET') {
    // 这个项目不依赖任何外部 Harness：可选模型完全来自使用者自己接入的服务商。
    const runtime = readRuntime(paths)
    const catalog = readCatalog(paths)
    const configured = new Map((catalog.providers ?? []).map((entry) => [entry.id, entry]))
    const providers = runtime.models.providers.map((entry) => {
      // 拉取过模型列表的以目录为准（含推理强度等元数据），否则用配置里手填的清单
      const known = configured.get(entry.route)
      if (known !== undefined && Array.isArray(known.models) && known.models.length > 0) return known
      return {
        id: entry.route,
        name: entry.displayName === '' ? entry.route : entry.displayName,
        models: entry.models.map((model) => ({ id: model.id, name: model.name === '' ? model.id : model.name }))
      }
    })
    return sendJson(response, 200, {
      current: { ...runtime.models.chat },
      kinds: runtime.models,
      providers,
      updatedAt: catalog.updatedAt ?? null
    })
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const lines = Number(url.searchParams.get('lines') ?? '300')
    return sendJson(response, 200, readLog(paths, Number.isFinite(lines) ? lines : 300))
  }

  if (pathname === '/api/image/test' && method === 'POST') {
    const body = await readBody(request)
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() !== '' ? body.prompt.trim() : '一只在键盘上打字的橘猫，卡通风格'
    const result = await testImage(paths, prompt, BASE)
    audit(paths, `image test → ${result.ok ? 'ok' : `fail: ${result.error}`}`)
    return sendJson(response, 200, result)
  }

  if (pathname === '/api/knowledge' && method === 'GET') {
    const index = readIndex(kbPaths)
    return sendJson(response, 200, {
      index,
      revision: index.revision,
      stats: statsOf(index),
      formats: SUPPORTED_FORMATS,
      maxUploadBytes: MAX_UPLOAD_BYTES
    })
  }
  if (pathname === '/api/knowledge' && method === 'PUT') {
    const body = await readBody(request)
    try {
      const next = writeIndex(kbPaths, body.index ?? {}, body.revision)
      audit(paths, `knowledge saved → revision ${next.revision}`)
      return sendJson(response, 200, { ok: true, revision: next.revision })
    } catch (error) {
      if (error?.code === 'REVISION_CONFLICT') {
        return sendJson(response, 409, { error: error.message, revision: error.revision })
      }
      throw error
    }
  }
  if (pathname === '/api/knowledge/upload' && method === 'POST') {
    const name = String(url.searchParams.get('name') ?? '').trim()
    if (name === '') return sendJson(response, 400, { error: '缺少文件名' })
    const buffer = await readBinary(request)
    if (buffer.length === 0) return sendJson(response, 400, { error: '文件是空的' })
    const result = addFile(kbPaths, {
      name,
      buffer,
      title: String(url.searchParams.get('title') ?? ''),
      description: String(url.searchParams.get('description') ?? ''),
      parent: String(url.searchParams.get('parent') ?? '')
    })
    audit(paths, `knowledge upload "${result.entry.title}" (${buffer.length} bytes, ${result.entry.chars} chars)`)
    return sendJson(response, 200, { ok: true, entry: result.entry, revision: result.index.revision })
  }
  if (pathname === '/api/knowledge/folder' && method === 'POST') {
    const body = await readBody(request)
    const result = addFolder(kbPaths, { title: body.title, parent: body.parent, description: body.description })
    audit(paths, `knowledge folder "${result.entry.title}"`)
    return sendJson(response, 200, { ok: true, entry: result.entry, revision: result.index.revision })
  }
  if (pathname === '/api/knowledge/delete' && method === 'POST') {
    const body = await readBody(request)
    const id = String(body.id ?? '')
    if (id === '') return sendJson(response, 400, { error: '缺少 id' })
    const index = removeEntry(kbPaths, id)
    audit(paths, `knowledge delete ${id}`)
    return sendJson(response, 200, { ok: true, revision: index.revision })
  }
  if (pathname === '/api/knowledge/text' && method === 'GET') {
    const id = String(url.searchParams.get('id') ?? '')
    const limit = Number(url.searchParams.get('limit') ?? '20000')
    const index = readIndex(kbPaths)
    const hit = readEntryText(kbPaths, index, id, Number.isFinite(limit) && limit > 0 ? limit : 20000)
    if (hit === undefined) return sendJson(response, 404, { error: '没有这个条目' })
    return sendJson(response, 200, {
      ok: true,
      id,
      title: hit.entry.title,
      kind: hit.entry.kind,
      text: hit.text,
      truncated: hit.truncated,
      chars: hit.entry.chars ?? hit.text.length,
      images: hit.entry.images ?? [],
      warning: hit.entry.warning ?? null
    })
  }
  if (pathname === '/api/knowledge/search' && method === 'GET') {
    const query = String(url.searchParams.get('q') ?? '').trim()
    const limit = Number(url.searchParams.get('limit') ?? '8')
    const index = readIndex(kbPaths)
    const results = query === '' ? [] : searchKnowledge(kbPaths, index, query, Number.isFinite(limit) && limit > 0 ? limit : 8)
    return sendJson(response, 200, { ok: true, query, results })
  }
  if (pathname === '/api/meta' && method === 'GET') {
    return sendJson(response, 200, { personaPresets: PERSONA_PRESETS, imagePresets: IMAGE_PROVIDER_PRESETS, version: VERSION })
  }

  if (pathname === '/healthz') return sendJson(response, 200, { ok: true, version: VERSION })

  return sendJson(response, 404, { error: 'not found' })
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  // 挂载前缀只在"入口"那一层存在：反代/网关可能已经剥过一次，也可能没有。
  // 这里统一剥掉，静态资源与 API 才落在同一套路径上。
  if (BASE !== '' && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) {
    url.pathname = url.pathname.slice(BASE.length) || '/'
  }
  const { pathname } = url

  const fail = (error) => {
    const status = Number(error?.statusCode ?? 500)
    if (status >= 500) console.error('[dashboard]', error)
    if (!response.headersSent) sendJson(response, status, { error: error?.message ?? '服务器内部错误' })
    else response.end()
  }

  try {
    // Generated media is deliberately unauthenticated: QQ's servers fetch it.
    if (pathname.startsWith('/media/')) {
      const name = normalize(pathname.slice('/media/'.length))
      if (name.includes('/') || name.includes('..') || name === '') {
        return sendJson(response, 400, { error: 'bad media path' })
      }
      return sendFile(response, join(paths.mediaDir, name), { cache: true })
    }
    // 知识库里抽出来的图片：和 /media/ 一样不鉴权，QQ 的服务器要能直接拉。
    if (pathname.startsWith('/kb-media/')) {
      const name = normalize(pathname.slice('/kb-media/'.length))
      if (name.includes('/') || name.includes('..') || name === '') {
        return sendJson(response, 400, { error: 'bad media path' })
      }
      const file = join(kbPaths.mediaDir, name)
      if (!existsSync(file)) return sendJson(response, 404, { error: '没有这张图' })
      return sendFile(response, file, { cache: true })
    }
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      route(request, response, url).catch(fail)
      return
    }
    // Static console assets.
    if (pathname === '/' || pathname === '/index.html') return sendIndex(response)
    const relative = normalize(pathname.slice(1))
    if (relative.includes('..')) return sendJson(response, 400, { error: 'bad path' })
    const file = join(paths.publicDir, relative)
    if (!existsSync(file)) return sendIndex(response)
    return sendFile(response, file)
  } catch (error) {
    fail(error)
  }
})

/** Print the addresses an operator can open. */
function announce() {
  const addresses = ['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter((entry) => entry !== undefined && entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address)]
  console.log(`[dashboard] 大肥鱼的QQ机器人服务 v${VERSION}`)
  console.log(`[dashboard] 家目录   : ${paths.home}`)
  console.log(`[dashboard] 运行时   : ${paths.runtimeDir}`)
  console.log(`[dashboard] 登录账号 : ${auth.username}（密码见 ${paths.authFile}，或 QQBOT_AUTH_PASSWORD 环境变量）`)
  for (const address of addresses) console.log(`[dashboard] 监听     : http://${address}:${PORT}${BASE}`)
}

const seeded = seedPlugins(paths)
if (seeded.length > 0) console.log(`[dashboard] 已初始化内置插件：${seeded.join(', ')}`)
announce()

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] ready on http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[dashboard] ${signal} received, shutting down`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
