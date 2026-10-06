/**
 * 知识库：本地资料的"书"——分类、目录、章节与正文。
 *
 * 使用者把常用资料（单位数据表、设定集、FAQ、产品手册）传进来，编排成有顺序的目录；
 * 对话时模型会先看到**目录**（标题 + 描述），需要细节时再通过工具读取具体条目，
 * 于是不必联网搜索，也就省掉了那几十秒的检索与等待。
 *
 * 存盘结构（都在 `<home>/runtime/knowledge/` 下）：
 *   index.json          目录（标题/描述/顺序/分类/文件元信息），原子写 + revision
 *   files/<id>/<原文件名>  原始文件
 *   text/<id>.txt       抽取出的纯文本（供模型与预览使用）
 *   media/<name>        从 docx/xlsx/pptx 里抽出来的图片
 *
 * 支持格式：txt / md / csv / tsv / ini / conf / json / log 直接读；
 * docx / xlsx / pptx 用内置 ZIP 解析器抽文字与图片（零依赖）。
 *
 * @module shared/knowledge
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

import { openZip } from './zip.js'

/** 单文件上限（超过就拒收，避免把磁盘写满）。 */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/** 单个条目抽出的文本上限（超出截断，防止把模型上下文撑爆）。 */
const MAX_TEXT_CHARS = 400_000

/** 模型一次最多读回多少字。 */
export const MAX_READ_CHARS = 40_000

/** 纯文本类扩展名。 */
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.ini', '.conf', '.cfg', '.json', '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.js', '.ts', '.py', '.sh', '.sql'])

/** 支持的上传格式（给控制台展示）。 */
export const SUPPORTED_FORMATS = ['txt', 'md', 'csv', 'tsv', 'ini', 'conf', 'json', 'log', 'yaml', 'xml', 'docx', 'xlsx', 'pptx']

/** 图片扩展名（抽出来直接给 QQ 用）。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

const nowIso = () => new Date().toISOString()

/** 解析知识库相关的所有路径，并确保目录存在。 */
export function resolveKnowledgePaths(home) {
  const root = join(home, 'runtime', 'knowledge')
  const paths = {
    root,
    indexFile: join(root, 'index.json'),
    filesDir: join(root, 'files'),
    textDir: join(root, 'text'),
    mediaDir: join(root, 'media')
  }
  for (const dir of [paths.root, paths.filesDir, paths.textDir, paths.mediaDir]) mkdirSync(dir, { recursive: true })
  return paths
}

/** 空目录。 */
export function emptyIndex() {
  return { version: 1, revision: 0, updatedAt: null, entries: [] }
}

/**
 * 读目录（缺失时返回空目录，不写盘）。
 * @param paths - `resolveKnowledgePaths()` 的结果。
 */
export function readIndex(paths) {
  try {
    const parsed = JSON.parse(readFileSync(paths.indexFile, 'utf8'))
    if (Array.isArray(parsed?.entries)) return normalizeIndex(parsed)
  } catch {
    /* 首次使用 */
  }
  return emptyIndex()
}

/** 归一化目录：字段类型与顺序都收敛，避免脏数据传进模型。 */
export function normalizeIndex(input) {
  const entries = (Array.isArray(input?.entries) ? input.entries : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
    .map((entry) => {
      const kind = entry.kind === 'folder' ? 'folder' : 'doc'
      return {
        id: entry.id,
        parent: typeof entry.parent === 'string' ? entry.parent : '',
        order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 100,
        title: typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title.trim() : entry.id,
        description: typeof entry.description === 'string' ? entry.description : '',
        kind,
        ...(kind === 'doc'
          ? {
              file: typeof entry.file === 'string' ? entry.file : '',
              ext: typeof entry.ext === 'string' ? entry.ext : '',
              bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : 0,
              chars: Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : 0,
              images: Array.isArray(entry.images) ? entry.images.filter((name) => typeof name === 'string') : [],
              uploadedAt: typeof entry.uploadedAt === 'string' ? entry.uploadedAt : null,
              warning: typeof entry.warning === 'string' ? entry.warning : undefined
            }
          : {})
      }
    })
  return {
    version: 1,
    revision: Number.isFinite(Number(input?.revision)) ? Number(input.revision) : 0,
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : null,
    entries
  }
}

/** 原子写盘并递增 revision。 */
export function writeIndex(paths, incoming, expectedRevision) {
  const current = readIndex(paths)
  if (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) {
    const error = new Error(`版本冲突：当前 revision=${current.revision}，提交的是 ${expectedRevision}`)
    error.code = 'REVISION_CONFLICT'
    error.revision = current.revision
    throw error
  }
  const next = normalizeIndex(incoming)
  next.revision = current.revision + 1
  next.updatedAt = nowIso()
  const temporary = `${paths.indexFile}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, paths.indexFile)
  return next
}

/** 生成一个新的条目 id。 */
export function newEntryId(existing) {
  const used = new Set(existing.map((entry) => entry.id))
  for (let index = 1; index < 100_000; index += 1) {
    const id = `k${index}`
    if (!used.has(id)) return id
  }
  return `k${Date.now()}`
}

/** 目录统计。 */
export function statsOf(index) {
  return {
    entries: index.entries.filter((entry) => entry.kind === 'doc').length,
    folders: index.entries.filter((entry) => entry.kind === 'folder').length,
    chars: index.entries.reduce((sum, entry) => sum + (entry.chars ?? 0), 0),
    bytes: index.entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)
  }
}

// ---------------------------------------------------------------- 文本抽取

/** 从 XML 里抽纯文本：保留段落/行边界，丢掉标签。 */
function textFromXml(xml, options = {}) {
  const blockTags = options.blockTags ?? ['w:p', 'a:p', 'row', 'si']
  let text = xml
  // 段落与换行：先把块级结束标签换成换行，避免整篇挤成一行
  for (const tag of blockTags) text = text.split(`</${tag}>`).join('\n')
  text = text.split('<w:tab/>').join('\t').split('<w:br/>').join('\n')
  text = text.replace(/<[^>]+>/g, '')
  return decodeXmlEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** XML 实体解码（&#x4E2D; 这类也要还原）。 */
function decodeXmlEntities(input) {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

/** 把 xlsx 的一张表转成制表符表格。 */
function sheetFromXml(xml, sharedStrings) {
  const rows = []
  const rowMatches = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []
  for (const row of rowMatches) {
    const cells = []
    const cellMatches = row.match(/<c[^>]*>[\s\S]*?<\/c>|<c[^>]*\/>/g) ?? []
    for (const cell of cellMatches) {
      const type = /t="([^"]+)"/.exec(cell)?.[1] ?? 'n'
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? ''
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(cell)?.[1]
      let value = inline !== undefined ? decodeXmlEntities(inline) : raw
      if (inline === undefined && type === 's') {
        const index = Number.parseInt(raw, 10)
        value = Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : ''
      }
      cells.push(value.replace(/[\t\n\r]+/g, ' ').trim())
    }
    if (cells.some((value) => value !== '')) rows.push(cells.join('\t'))
  }
  return rows.join('\n')
}

/**
 * 从文件内容抽取纯文本与内嵌图片。
 * @param buffer - 文件内容。
 * @param extension - 扩展名（含点，小写）。
 * @returns `{ text, images: [{ name, data }], warning? }`。
 */
export function extractFromBuffer(buffer, extension) {
  if (TEXT_EXTENSIONS.has(extension)) {
    let text = buffer.toString('utf8')
    // 简单的乱码判定：UTF-8 解码出现大量替换字符，多半是 GBK 之类的老编码
    const replacements = (text.match(/\uFFFD/g) ?? []).length
    let warning
    if (replacements > text.length / 200 && text.length > 0) {
      warning = `${extension} 不是 UTF-8 编码（可能是 GBK/GB18030），已尽力读取，建议另存为 UTF-8 后重新上传`
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return { text: text.slice(0, MAX_TEXT_CHARS), images: [], warning }
  }

  if (extension === '.docx' || extension === '.xlsx' || extension === '.pptx') {
    const zip = openZip(buffer)
    const images = zip
      .names.filter((name) => /(^word\/media\/|^xl\/media\/|^ppt\/media\/)/.test(name) && IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
      .map((name) => ({ name: name.split('/').pop(), data: zip.read(name) }))

    if (extension === '.docx') {
      const document = zip.read('word/document.xml')
      if (document === undefined) throw new Error('docx 里找不到 word/document.xml')
      return { text: textFromXml(document.toString('utf8'), { blockTags: ['w:p', 'w:tr'] }).slice(0, MAX_TEXT_CHARS), images }
    }
    if (extension === '.xlsx') {
      const shared = zip.read('xl/sharedStrings.xml')
      const sharedStrings = shared === undefined
        ? []
        : (shared.toString('utf8').match(/<si>[\s\S]*?<\/si>/g) ?? []).map((item) => textFromXml(item, { blockTags: [] }))
      const sheets = zip.names.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
      const parts = []
      for (const [index, name] of sheets.entries()) {
        const body = sheetFromXml(zip.read(name).toString('utf8'), sharedStrings)
        if (body !== '') parts.push(`# 工作表 ${index + 1}\n${body}`)
      }
      return { text: parts.join('\n\n').slice(0, MAX_TEXT_CHARS), images }
    }
    const slides = zip.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort()
    const parts = []
    for (const [index, name] of slides.entries()) {
      const body = textFromXml(zip.read(name).toString('utf8'), { blockTags: ['a:p'] })
      if (body !== '') parts.push(`# 幻灯片 ${index + 1}\n${body}`)
    }
    return { text: parts.join('\n\n').slice(0, MAX_TEXT_CHARS), images }
  }

  if (extension === '.pdf') {
    return { text: '', images: [], warning: '暂不支持 PDF 直接抽取，请另存为 txt/docx 后上传' }
  }

  return {
    text: '',
    images: [],
    warning: `暂不支持 ${extension || '这种'} 格式，已保存原文件但没能抽出文本（支持：${SUPPORTED_FORMATS.join(' / ')}）`
  }
}

// ---------------------------------------------------------------- 增删读写

/**
 * 保存一个上传的文件：落盘原件、抽文本、抽图片、登记到目录。
 * @param paths - 知识库路径。
 * @param input - `{ name, buffer, title?, parent?, description? }`。
 * @returns `{ index, entry }`。
 */
export function addFile(paths, input) {
  const fileName = String(input.name ?? '').split(/[\\/]/).pop() ?? ''
  if (fileName === '') throw new Error('缺少文件名')
  const extension = extname(fileName).toLowerCase()
  if (input.buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`文件超过 ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)} MB 上限`)
  }

  const index = readIndex(paths)
  const id = newEntryId(index.entries)
  mkdirSync(join(paths.filesDir, id), { recursive: true })
  writeFileSync(join(paths.filesDir, id, fileName), input.buffer, { mode: 0o600 })

  let extracted = { text: '', images: [], warning: undefined }
  try {
    extracted = extractFromBuffer(input.buffer, extension)
  } catch (error) {
    extracted = { text: '', images: [], warning: `解析失败：${error?.message ?? String(error)}` }
  }

  if (extracted.text !== '') writeFileSync(join(paths.textDir, `${id}.txt`), extracted.text, { mode: 0o600 })
  const imageNames = []
  for (const [index_, image] of (extracted.images ?? []).entries()) {
    const suffix = extname(image.name).toLowerCase() || '.png'
    const name = `${id}-${index_ + 1}${suffix}`
    writeFileSync(join(paths.mediaDir, name), image.data, { mode: 0o600 })
    imageNames.push(name)
  }

  const entry = {
    id,
    parent: typeof input.parent === 'string' ? input.parent : '',
    order: nextOrder(index.entries, input.parent ?? ''),
    title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : fileName.replace(/\.[^.]+$/, ''),
    description: typeof input.description === 'string' ? input.description : '',
    kind: 'doc',
    file: fileName,
    ext: extension.replace(/^\./, ''),
    bytes: input.buffer.length,
    chars: extracted.text.length,
    images: imageNames,
    uploadedAt: nowIso(),
    ...(extracted.warning === undefined ? {} : { warning: extracted.warning })
  }
  const next = writeIndex(paths, { ...index, entries: [...index.entries, entry] })
  return { index: next, entry: { ...next.entries.find((item) => item.id === id), warning: extracted.warning } }
}

/** 同一个分类下的下一个顺序号。 */
export function nextOrder(entries, parent) {
  const orders = entries.filter((entry) => (entry.parent ?? '') === (parent ?? '')).map((entry) => entry.order ?? 0)
  return orders.length === 0 ? 10 : Math.max(...orders) + 10
}

/** 新建一个分类（章）。 */
export function addFolder(paths, input) {
  const index = readIndex(paths)
  const entry = {
    id: newEntryId(index.entries),
    parent: typeof input?.parent === 'string' ? input.parent : '',
    order: nextOrder(index.entries, input?.parent ?? ''),
    title: typeof input?.title === 'string' && input.title.trim() !== '' ? input.title.trim() : '新分类',
    description: typeof input?.description === 'string' ? input.description : '',
    kind: 'folder'
  }
  const next = writeIndex(paths, { ...index, entries: [...index.entries, entry] })
  return { index: next, entry }
}

/**
 * 删除条目（分类会连带删除其下所有后代），并清理文件。
 * @returns 新的目录。
 */
export function removeEntry(paths, id) {
  const index = readIndex(paths)
  const doomed = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const entry of index.entries) {
      if (!doomed.has(entry.id) && doomed.has(entry.parent ?? '')) {
        doomed.add(entry.id)
        grew = true
      }
    }
  }
  for (const entry of index.entries) {
    if (!doomed.has(entry.id) || entry.kind !== 'doc') continue
    try {
      rmSync(join(paths.filesDir, entry.id), { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(join(paths.textDir, `${entry.id}.txt`), { force: true })
    } catch {
      /* 忽略 */
    }
    for (const image of entry.images ?? []) {
      try {
        rmSync(join(paths.mediaDir, image), { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
  return writeIndex(paths, { ...index, entries: index.entries.filter((entry) => !doomed.has(entry.id)) })
}

/** 读一条目的全文（供模型工具与控制台预览）。 */
export function readEntryText(paths, index, id, limit = MAX_READ_CHARS) {
  const entry = index.entries.find((item) => item.id === id)
  if (entry === undefined) return undefined
  if (entry.kind !== 'doc') return { entry, text: '', truncated: false }
  let text = ''
  try {
    text = readFileSync(join(paths.textDir, `${id}.txt`), 'utf8')
  } catch {
    text = ''
  }
  const truncated = text.length > limit
  return { entry, text: truncated ? text.slice(0, limit) : text, truncated }
}

// ---------------------------------------------------------------- 检索与提示词

/** 把查询切成词元：英文按词，中文按二元组（粗粒度但够用）。 */
function tokenize(query) {
  const tokens = new Set()
  for (const chunk of String(query).toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (chunk === '') continue
    if (/^[\p{Script=Han}]+$/u.test(chunk)) {
      if (chunk.length <= 2) tokens.add(chunk)
      for (let index = 0; index < chunk.length - 1; index += 1) tokens.add(chunk.slice(index, index + 2))
    } else {
      tokens.add(chunk)
    }
  }
  return [...tokens]
}

/**
 * 在知识库里检索。
 * @param paths - 知识库路径。
 * @param index - 当前目录。
 * @param query - 关键词。
 * @param limit - 最多返回几条。
 * @returns `[{ id, title, parentTitle, snippet, score }]`。
 */
export function search(paths, index, query, limit = 8) {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const titleOf = (id) => index.entries.find((entry) => entry.id === id)?.title ?? ''
  const results = []
  for (const entry of index.entries) {
    if (entry.kind !== 'doc') continue
    let text = ''
    try {
      text = readFileSync(join(paths.textDir, `${entry.id}.txt`), 'utf8')
    } catch {
      continue
    }
    const haystack = text.toLowerCase()
    const title = entry.title.toLowerCase()
    const description = (entry.description ?? '').toLowerCase()
    let score = 0
    let firstHit = -1
    for (const token of tokens) {
      if (title.includes(token)) score += 12
      if (description.includes(token)) score += 5
      let from = 0
      let hits = 0
      while (hits < 40) {
        const at = haystack.indexOf(token, from)
        if (at < 0) break
        hits += 1
        if (firstHit < 0 || at < firstHit) firstHit = at
        from = at + token.length
      }
      score += Math.min(hits, 20)
    }
    if (score <= 0) continue
    const start = Math.max(0, (firstHit < 0 ? 0 : firstHit) - 120)
    const snippet = text.slice(start, start + 320).replace(/\s+/g, ' ').trim()
    results.push({ id: entry.id, title: entry.title, parentTitle: titleOf(entry.parent), snippet, score })
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit)
}

/**
 * 生成给模型的"目录"段落。
 *
 * 只放标题、描述与 id——正文由模型按需调用工具读取，避免把上下文塞满。
 * 这一段会追加在人格之后，所以优先级天然低于人格设定。
 */
export function composeCatalog(index, options = {}) {
  const maxEntries = options.maxEntries ?? 60
  const docs = index.entries.filter((entry) => entry.kind === 'doc')
  if (docs.length === 0) return ''
  const folders = new Map(index.entries.filter((entry) => entry.kind === 'folder').map((entry) => [entry.id, entry]))
  const sorted = [...index.entries].sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  const lines = []
  for (const entry of sorted) {
    if (entry.kind === 'folder') {
      lines.push(`- 【分类】${entry.title}${entry.description === '' ? '' : `：${entry.description}`}`)
      continue
    }
    if (lines.length >= maxEntries) {
      lines.push(`- …（还有 ${docs.length - lines.length} 条，可用 kb_search 检索）`)
      break
    }
    const folder = folders.get(entry.parent)
    const where = folder === undefined ? '' : `${folder.title} / `
    const hint = entry.description === '' ? '' : `：${entry.description}`
    lines.push(`- ${where}${entry.title}（id=${entry.id}，${entry.chars ?? 0} 字）${hint}`)
  }
  return [
    '【本机知识库】',
    '下面这些资料已经存在本机上，**回答相关问题前先查它们**，不要联网搜索：',
    ...lines,
    '用法：用 kb_search(关键词) 定位，再用 kb_read(id) 读取正文；需要目录时用 kb_list()。',
    '知识库只是事实来源，与上面的角色设定冲突时，一律以角色设定为准。'
  ].join('\n')
}

/** 列出磁盘上实际存在的图片（控制台预览用）。 */
export function listMedia(paths) {
  try {
    return readdirSync(paths.mediaDir)
  } catch {
    return []
  }
}

/** 目录是否为空（用于决定要不要注入提示词）。 */
export function isEmpty(index) {
  return index.entries.every((entry) => entry.kind !== 'doc')
}

/** 读原始文件（控制台下载用）。 */
export function readOriginal(paths, index, id) {
  const entry = index.entries.find((item) => item.id === id)
  if (entry === undefined || entry.kind !== 'doc') return undefined
  const file = join(paths.filesDir, entry.id, entry.file)
  if (!existsSync(file)) return undefined
  return { entry, file, bytes: statSync(file).size }
}
