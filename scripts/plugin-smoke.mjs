/**
 * Local mount harness for the bridge plugin.
 *
 * Runs `bridge/index.js`'s `apply()` against a stub Host context so a mount
 * failure surfaces here, with a stack trace, instead of inside the Harness
 * process where its logger is a pipe.
 *
 * Usage:
 *   node scripts/plugin-smoke.mjs                 # 用临时目录，绝不碰真实部署
 *   node scripts/plugin-smoke.mjs --home=/path    # 明确指定工作目录
 *
 * 工作目录决定它读写哪个 qqbot-status.json / qqbot.log，所以默认是**新建的临时目录**：
 * 早先的版本沿用补丁里的 home，一次自测就会把 stub 状态写进线上状态文件。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('.', import.meta.url)
const patch = readFileSync(new URL('../qqbot-core/cordis.patch.yml', here), 'utf8')
const field = (name) => patch.match(new RegExp(`^\\s*${name}:\\s*'([^']*)'`, 'm'))?.[1]

const homeFlag = process.argv.slice(2).find((arg) => arg.startsWith('--home='))
const temporary = homeFlag === undefined
const home = temporary ? mkdtempSync(join(tmpdir(), 'qqbot-smoke-')) : homeFlag.slice('--home='.length)
if (temporary) {
  process.on('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉也无所谓 */
    }
  })
}

const config = {
  enabled: true,
  appId: field('appId'),
  clientSecret: field('clientSecret'),
  home
}

console.log('config:', { ...config, clientSecret: `${String(config.clientSecret).slice(0, 6)}…` })
console.log(`home: ${home}${temporary ? '（临时目录，用完即删）' : ''}`)

const listeners = []
const effects = []
const services = {
  agents: { list: () => [] },
  sessions: { flush: async () => true },
  tools: {
    schemas: () => [
      { name: 'web_search', description: 'stub' },
      { name: 'web_fetch', description: 'stub' },
      { name: 'bash', description: 'stub' }
    ]
  },
  llm: {
    listProviders: () => [{ id: 'stub-provider', name: 'Stub' }],
    listModels: async () => [{ id: 'stub-model', name: 'Stub Model' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } })
  },
  agentDefaultModel: {
    currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model', reasoningEffort: 'max' }),
    saveSelection: async () => {}
  }
}

const ctx = {
  logger: {
    info: (...args) => console.log('[ctx.info ]', ...args),
    warn: (...args) => console.log('[ctx.warn ]', ...args),
    error: (...args) => console.log('[ctx.error]', ...args),
    debug: () => {}
  },
  on: (name, callback) => {
    listeners.push({ name, callback })
    return () => {}
  },
  get: (name) => services[name],
  effect: (callback) => {
    const disposer = callback()
    const wrapped = typeof disposer === 'function' ? disposer : () => {}
    effects.push(wrapped)
    return wrapped
  }
}

const module = await import(new URL('../qqbot-core/index.js', here))
console.log('loaded index.js, exports:', Object.keys(module).join(', '))

try {
  const dispose = await module.apply(ctx, config)
  console.log('apply() resolved; disposer type:', typeof dispose)
  await new Promise((done) => setTimeout(done, 2500))
  console.log('still alive after 2.5s — mount is healthy')
  if (typeof dispose === 'function') await dispose()
  console.log('disposed cleanly')
  process.exit(0)
} catch (error) {
  console.error('MOUNT FAILED:', error)
  process.exit(1)
}
