import assert from 'node:assert/strict'
import test from 'node:test'
import { generateGeminiImage, generateText } from '../server/providers.js'

async function withGeminiKey(run) {
  const originalKey = process.env.GEMINI_API_KEY
  const originalFetch = globalThis.fetch
  process.env.GEMINI_API_KEY = 'unit-test-key-not-valid'
  try {
    return await run((fetchMock) => { globalThis.fetch = fetchMock })
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
  }
}

test('Gemini text requests keep the key in a header and normalize responses', async () => {
  await withGeminiKey(async (mockFetch) => {
    let request
    mockFetch(async (url, options) => {
      request = { url: String(url), options }
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Antwort von Gemini' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const result = await generateText({ provider: 'gemini', geminiModel: 'gemini-test' }, {
      systemPrompt: 'Antworte knapp.',
      messages: [{ role: 'user', content: 'Hallo' }],
    })
    assert.equal(result.content, 'Antwort von Gemini')
    assert.equal(result.usage.promptTokenCount, 12)
    assert.equal(request.options.headers['x-goog-api-key'], 'unit-test-key-not-valid')
    assert.equal(request.url.includes('unit-test-key-not-valid'), false)
  })
})

test('Gemini image requests return generated image data', async () => {
  await withGeminiKey(async (mockFetch) => {
    mockFetch(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [
      { text: 'Bild fertig' },
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
    ] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const result = await generateGeminiImage({ geminiImageModel: 'gemini-image-test' }, 'Ein Neon-Schild')
    assert.equal(result.content, 'Bild fertig')
    assert.equal(result.image, 'data:image/png;base64,aGVsbG8=')
  })
})

test('Gemini image editing sends the selected image as inline data', async () => {
  await withGeminiKey(async (mockFetch) => {
    let payload
    mockFetch(async (_url, options) => {
      payload = JSON.parse(options.body)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { inlineData: { mimeType: 'image/png', data: 'ZWRpdGVk' } },
      ] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const result = await generateGeminiImage(
      { geminiImageModel: 'gemini-image-test' },
      'Mache den Himmel violett',
      'data:image/png;base64,aW1hZ2U=',
    )
    assert.equal(payload.contents[0].parts[1].inlineData.data, 'aW1hZ2U=')
    assert.equal(result.image, 'data:image/png;base64,ZWRpdGVk')
  })
})

test('Ollama remains available as the backup text provider', async () => {
  const originalFetch = globalThis.fetch
  try {
    let request
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), body: JSON.parse(options.body) }
      return new Response(JSON.stringify({ message: { content: 'Antwort vom Backup' }, eval_count: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const result = await generateText({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', model: 'qwen3' }, {
      systemPrompt: 'Larky',
      messages: [{ role: 'user', content: 'Test' }],
    })
    assert.equal(result.content, 'Antwort vom Backup')
    assert.equal(result.model, 'qwen3')
    assert.equal(request.url, 'http://127.0.0.1:11434/api/chat')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Gemini clearly reports when no server key is configured', async () => {
  const originalKey = process.env.GEMINI_API_KEY
  const originalFetch = globalThis.fetch
  delete process.env.GEMINI_API_KEY
  globalThis.fetch = async () => { throw new Error('fetch must not run without a key') }
  try {
    await assert.rejects(
      generateText({ provider: 'gemini', geminiModel: 'gemini-test' }, { systemPrompt: '', messages: [] }),
      /GEMINI_API_KEY/,
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey !== undefined) process.env.GEMINI_API_KEY = originalKey
  }
})
