/**
 * Row configuration: the deployment plumbing authored in `cordis.patch.yml`.
 *
 * Everything an operator changes day to day lives in the *runtime* document
 * (`runtime/qqbot.config.json`) that the dashboard edits; this module only
 * resolves how the bridge connects and where its files are.
 *
 * @module @local/dsh-qqbot-core/config
 */

import { join } from 'node:path'

/** Intents bit covering C2C_MESSAGE_CREATE and GROUP_AT_MESSAGE_CREATE. */
export const INTENT_GROUP_AND_C2C = 1 << 25

/** Intent bit covering INTERACTION_CREATE (message buttons / quick menus). */
export const INTENT_INTERACTION = 1 << 26

const DEFAULTS = {
  enabled: true,
  appId: '',
  clientSecret: '',
  clientSecretEnv: '',
  baseUrl: 'https://api.bot.qq.com',
  intents: INTENT_GROUP_AND_C2C,
  shardId: 0,
  shardCount: 1,
  home: '',
  sessionPrefix: 'session-qq-',
  turnTimeoutMs: 300000,
  logPayloads: false,
  modelCatalogEveryMs: 900000,
  consoleRoute: '/qqbot',
  consoleTarget: 'http://127.0.0.1:9999',
  consoleEntry: '',
  consoleAutoStart: true
}

const asString = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

function asInteger(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

/**
 * Resolve the plugin row config into absolute paths and connection settings.
 * @param raw - raw `config` object from the loader row.
 * @param fallbackHome - directory used when the row names no home.
 * @returns the normalized row configuration.
 */
export function normalizeConfig(raw, fallbackHome = process.cwd()) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const home = asString(source.home, fallbackHome)
  const secretEnv = asString(source.clientSecretEnv, '')
  const appIdEnv = asString(source.appIdEnv, '')

  return {
    enabled: asBoolean(source.enabled, DEFAULTS.enabled),
    appId: asString(source.appId, '') || (appIdEnv === '' ? '' : asString(process.env[appIdEnv], '')),
    clientSecret: asString(source.clientSecret, '') || (secretEnv === '' ? '' : asString(process.env[secretEnv], '')),
    clientSecretEnv: secretEnv,
    baseUrl: asString(source.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, ''),
    intents: asInteger(source.intents, DEFAULTS.intents, 0),
    shardId: asInteger(source.shardId, DEFAULTS.shardId, 0),
    shardCount: asInteger(source.shardCount, DEFAULTS.shardCount, 1),
    home,
    sessionCwd: asString(source.sessionCwd, home),
    sessionPrefix: asString(source.sessionPrefix, DEFAULTS.sessionPrefix),
    runtimeDir: asString(source.runtimeDir, join(home, 'runtime')),
    pluginsDir: asString(source.pluginsDir, join(home, 'plugins')),
    mediaDir: asString(source.mediaDir, join(home, 'runtime', 'media')),
    statusFile: asString(source.statusFile, join(home, 'qqbot-status.json')),
    logFile: asString(source.logFile, join(home, 'qqbot.log')),
    turnTimeoutMs: asInteger(source.turnTimeoutMs, DEFAULTS.turnTimeoutMs, 10000, 86400000),
    logPayloads: asBoolean(source.logPayloads, DEFAULTS.logPayloads),
    modelCatalogEveryMs: asInteger(source.modelCatalogEveryMs, DEFAULTS.modelCatalogEveryMs, 60000, 86400000),
    consoleRoute: typeof source.consoleRoute === 'string' ? source.consoleRoute.trim() : DEFAULTS.consoleRoute,
    consoleTarget: asString(source.consoleTarget, DEFAULTS.consoleTarget),
    consoleEntry: asString(source.consoleEntry, join(home, 'dashboard', 'server.js')),
    consoleAutoStart: asBoolean(source.consoleAutoStart, DEFAULTS.consoleAutoStart)
  }
}
