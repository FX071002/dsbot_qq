/**
 * `@local/dsh-qqbot-core` — QQ 官方机器人桥接（可独立运行，也可挂进 DeepSeek Harness）
 * platform (QQ 开放平台, bot.q.qq.com), driven by the companion dashboard.
 *
 * This entry point is deliberately tiny and (once installed) never needs to
 * change again: the Host caches plugin modules by package specifier, so code
 * edits inside this bundle would otherwise never take effect. Instead every
 * mount imports `lib/app.js` through a fresh URL, and touching
 * `runtime/reload.request` performs that import again — so the dashboard can
 * hot-reload the bridge after any edit, with no Harness restart.
 *
 * @module @local/dsh-qqbot-core
 */

import { join } from 'node:path'
import { watch } from 'node:fs'

/** The plugin's row identity. */
export const name = 'qqbot'

/** The Harness capability this bridge drives. */
export const inject = ['sessionController']

/**
 * Resolve the runtime directory from the raw row config.
 * @param config - the plugin row's raw config.
 * @returns the absolute runtime directory.
 */
function runtimeDirOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const home = typeof source.home === 'string' && source.home.trim() !== '' ? source.home.trim() : process.cwd()
  return typeof source.runtimeDir === 'string' && source.runtimeDir.trim() !== ''
    ? source.runtimeDir.trim()
    : join(home, 'runtime')
}

/**
 * Mount the bridge, and keep it remountable.
 * @param ctx - host plugin context.
 * @param config - the plugin row's raw config.
 * @returns the disposer that unloads whatever is currently mounted.
 */
export async function apply(ctx, config) {
  let current

  const load = async () => {
    const previous = current
    current = undefined
    if (previous !== undefined) {
      try {
        await previous()
      } catch (error) {
        ctx.logger.warn?.(`qqbot: 卸载上一代实现失败：${error?.message ?? String(error)}`)
      }
    }
    const stamp = Date.now().toString(36)
    const implementation = await import(new URL(`./lib/app.js?v=${stamp}`, import.meta.url))
    current = await implementation.mount(ctx, config)
  }

  await load()

  let watcher
  try {
    watcher = watch(runtimeDirOf(config), { persistent: true }, (_event, filename) => {
      const changed = filename === null ? '' : String(filename)
      if (changed !== 'reload.request') return
      ctx.logger.info?.('qqbot: 收到重载请求，重新导入实现')
      void load().catch((error) => ctx.logger.error?.(`qqbot: 重新加载失败：${error?.stack ?? String(error)}`))
    })
    watcher.unref?.()
  } catch (error) {
    ctx.logger.warn?.(`qqbot: 监听 reload.request 失败：${error?.message ?? String(error)}`)
  }

  return async () => {
    try {
      watcher?.close()
    } catch {
      /* already closed */
    }
    const previous = current
    current = undefined
    if (previous !== undefined) {
      try {
        await previous()
      } catch (error) {
        ctx.logger.warn?.(`qqbot: 卸载实现失败：${error?.message ?? String(error)}`)
      }
    }
  }
}
