/**
 * 极简 ZIP 读取器（只读，零依赖）。
 *
 * docx / xlsx / pptx 都是 ZIP 包，为了不给项目引入 npm 依赖，这里直接解析
 * 中央目录并按需解压条目（stored 或 deflate）。只实现读取所需的子集：
 * 不写、不加密、不支持 ZIP64（超过 4 GB 的包会明确报错而不是给出错误数据）。
 *
 * @module shared/zip
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const ZIP64_MARKER = 0xffffffff

/**
 * 找到中央目录的结束记录（EOCD 在文件末尾，注释最长 64 KiB）。
 * @param buffer - 整个文件内容。
 * @returns EOCD 的偏移，找不到返回 -1。
 */
function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * 列出一个 ZIP 包的条目。
 * @param buffer - 整个文件内容。
 * @returns `[{ name, method, compressedSize, size, offset }]`。
 */
export function listEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  if (eocd < 0) throw new Error('不是有效的 ZIP 包（找不到中央目录）')
  const count = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER || count === 0xffff) {
    throw new Error('这个文件用了 ZIP64 格式，暂不支持')
  }
  if (directoryOffset + directorySize > buffer.length) throw new Error('ZIP 中央目录越界，文件可能已损坏')

  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const offset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    entries.push({ name, method, compressedSize, size, offset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 解压一个条目。
 * @param buffer - 整个文件内容。
 * @param entry - `listEntries()` 返回的条目。
 * @returns Buffer。
 */
export function readEntry(buffer, entry) {
  const { offset } = entry
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error(`条目 ${entry.name} 的本地头无效`)
  }
  const nameLength = buffer.readUInt16LE(offset + 26)
  const extraLength = buffer.readUInt16LE(offset + 28)
  const start = offset + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(raw)
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error(`条目 ${entry.name} 使用了不支持的压缩方式（method=${entry.method}）`)
}

/**
 * 按名字读一个条目。
 * @param buffer - 整个文件内容。
 * @param name - 条目全名（区分大小写）。
 * @returns Buffer 或 undefined。
 */
export function readEntryByName(buffer, name) {
  const entry = listEntries(buffer).find((candidate) => candidate.name === name)
  return entry === undefined ? undefined : readEntry(buffer, entry)
}

/**
 * 打开一个 ZIP，返回便于按名读取与按前缀筛选的句柄。
 * @param buffer - 整个文件内容。
 */
export function openZip(buffer) {
  const entries = listEntries(buffer)
  return {
    names: entries.map((entry) => entry.name),
    /** 读单个条目。 */
    read(name) {
      const entry = entries.find((candidate) => candidate.name === name)
      return entry === undefined ? undefined : readEntry(buffer, entry)
    },
    /** 读该前缀下的所有条目，返回 `[{ name, data }]`。 */
    readPrefix(prefix) {
      return entries
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => ({ name: entry.name, data: readEntry(buffer, entry) }))
    }
  }
}
