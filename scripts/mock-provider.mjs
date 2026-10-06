#!/usr/bin/env node
/**
 * 本地模拟服务商：一个 OpenAI 兼容的小网关，用来在**不花任何额度**的前提下
 * 验证控制台各处的连通性测试。
 *
 *   node scripts/mock-provider.mjs 10199
 *
 * 提供：
 *   GET  /v1/models                → mock-chat / mock-embed / mock-rerank / mock-tts / mock-stt
 *   POST /v1/chat/completions      → 流式与非流式都支持
 *   POST /v1/embeddings            → 8 维假向量
 *   POST /v1/rerank                → 两条排序结果
 *   POST /v1/audio/speech          → 一小段假音频字节
 *   POST /v1/audio/transcriptions  → 固定转写文本
 *
 * 仅用于自测，不要用于生产。
 */

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 10199)
const MODELS = [
  { id: 'mock-chat', object: 'model', owned_by: 'mock' },
  { id: 'mock-embed', object: 'model', owned_by: 'mock' },
  { id: 'mock-rerank', object: 'model', owned_by: 'mock' },
  { id: 'mock-tts', object: 'model', owned_by: 'mock' },
  { id: 'mock-stt', object: 'model', owned_by: 'mock' }
]

const json = (response, status, body) => {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`)
  const path = url.pathname

  if (path === '/v1/models') return json(response, 200, { object: 'list', data: MODELS })

  if (path === '/v1/embeddings') {
    const body = await readBody(request)
    const vector = Array.from({ length: 8 }, (_, index) => Number((Math.sin(index + 1) * 0.5).toFixed(6)))
    return json(response, 200, {
      object: 'list',
      model: body.model ?? 'mock-embed',
      data: [{ object: 'embedding', index: 0, embedding: vector }],
      usage: { prompt_tokens: 3, total_tokens: 3 }
    })
  }

  if (path === '/v1/rerank') {
    const body = await readBody(request)
    const documents = Array.isArray(body.documents) ? body.documents : []
    return json(response, 200, {
      model: body.model ?? 'mock-rerank',
      results: documents
        .map((_, index) => ({ index, relevance_score: Number((1 - index * 0.1).toFixed(2)) }))
        .slice(0, body.top_n ?? documents.length)
    })
  }

  if (path === '/v1/audio/speech') {
    const audio = Buffer.alloc(2048, 7)
    response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length })
    return response.end(audio)
  }

  if (path === '/v1/audio/transcriptions') return json(response, 200, { text: '这是模拟服务商返回的转写结果' })

  if (path === '/v1/chat/completions') {
    const body = await readBody(request)
    const model = body.model ?? 'mock-chat'

    // 脚本化的工具调用：模型先查知识库，再照着查到的内容回答。
    // 这样无需真实模型也能验证"目录 → 检索 → 读正文 → 作答"这条链路。
    const toolNames = (body.tools ?? []).map((tool) => tool.function?.name)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const toolResult = [...messages].reverse().find((message) => message.role === 'tool')
    if (toolNames.includes('kb_search') && toolResult === undefined) {
      const question = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''
      const keyword = /伊利卡拉/.test(question) ? '伊利卡拉' : question.slice(0, 12)
      return json(response, 200, {
        id: 'chatcmpl-mock-tool',
        object: 'chat.completion',
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_kb_1',
                  type: 'function',
                  function: { name: 'kb_search', arguments: JSON.stringify({ query: keyword }) }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      })
    }
    if (toolResult !== undefined) {
      const firstValue = String(toolResult.content).match(/Strength=(\d+)|生命值[：: ]*(\d+)/)
      const reply = `根据本机资料：伊利卡拉空中要塞生命值 ${firstValue ? firstValue[1] ?? firstValue[2] : '未知'}（来自知识库，未联网）`
      return json(response, 200, {
        id: 'chatcmpl-mock-final',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }]
      })
    }

    const reply = `你好，我是 ${model}（本地模拟服务商）`
    if (body.stream !== true) {
      return json(response, 200, {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }]
      })
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`)
    for (const piece of reply.match(/.{1,6}/gu) ?? []) {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`)
    }
    response.write('data: [DONE]\n\n')
    return response.end()
  }

  return json(response, 404, { error: { message: `mock 未实现：${path}` } })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock 服务商已启动：http://127.0.0.1:${port}/v1（模型 ${MODELS.map((m) => m.id).join('、')}）`)
})
