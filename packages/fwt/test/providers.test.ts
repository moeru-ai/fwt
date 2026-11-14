import type { ModelConfigInput } from '../src/providers'

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { createMemoryIo } from '@moeru/cliff/testing'
import { generateText } from '@xsai/text'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { version } from '../package.json' with { type: 'json' }
import { fwtDirs } from '../src/home'
import { addProvider, fetchCatalog, listProviders, readAuth, readConfig, removeProvider, resolveModel, resolveRecordedModel } from '../src/providers'

const MODELS_DEV = {
  'deepseek': {
    doc: 'https://api-docs.deepseek.com',
    env: ['DEEPSEEK_API_KEY'],
    id: 'deepseek',
    models: {
      'deepseek-flash': {
        api: {
          'chat-completions': { base_url: 'https://api.deepseek.com' },
          'messages': { base_url: 'https://api.deepseek.com/anthropic/v1' },
        },
        limit: { context: 1_048_576, output: 393_216 },
        modalities: { input: ['text', 'image/png'] },
        name: 'DeepSeek V4.1 Flash',
      },
      'deepseek-messages-only': {
        api: { messages: { base_url: 'https://api.deepseek.com/anthropic/v1' } },
        limit: { context: 0, output: 0 },
        modalities: { input: ['text'] },
      },
    },
    name: 'DeepSeek',
  },
  'google': {
    env: ['GEMINI_API_KEY'],
    models: { 'gemini-x': { api: { 'generate-content': { base_url: 'https://g.example' } } } },
    name: 'Google',
  },
  'opencode-go': {
    env: ['OPENCODE_API_KEY'],
    models: { 'glm-5.3-flash': { api: { 'chat-completions': { base_url: 'https://opencode.ai/inference/go/openai/v1' } } } },
    name: 'OpenCode Go',
  },
}

const modelsDevFetch = (calls: Request[] = []) => async (request: Request): Promise<Response> => {
  calls.push(request)
  if (request.headers.get('if-none-match') === '"v1"')
    return new Response(null, { status: 304 })
  return Response.json(MODELS_DEV, { headers: { etag: '"v1"' } })
}

const probe = async (input: ModelConfigInput) => {
  const requests: Request[] = []
  const resolved = resolveModel({
    ...input,
    fetch: async (request) => {
      requests.push(request)
      return new Response('stop', { status: 400 })
    },
  })
  await generateText(resolved.languageModel('session-1'), {
    input: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
    maxOutputTokens: 1,
    reasoningEffort: resolved.effort,
  }).catch((error: unknown) => {
    if (requests.length === 0)
      throw error
  })
  const request = requests[0]
  return {
    apiKey: request.headers.get('x-api-key') ?? request.headers.get('authorization')?.replace('Bearer ', ''),
    body: await request.json() as Record<string, unknown>,
    headers: request.headers,
    resolved,
    url: request.url,
  }
}

describe('providers', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    while (cleanups.length > 0)
      await cleanups.pop()?.()
  })

  const makeHome = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-providers-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))
    return dir
  }

  it('adds a models.dev provider without making it the default, and picks the protocol per model', async () => {
    const home = await makeHome()
    const io = createMemoryIo()
    await addProvider({ apiKey: 'sk-saved', fetch: modelsDevFetch(), home, io, makeDefault: false, model: 'deepseek-flash', provider: 'deepseek' })

    expect(io.stdout.text()).toBe('Added DeepSeek (deepseek) with model deepseek-flash.\n')
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe([
      '[providers.deepseek]',
      'env_key = "DEEPSEEK_API_KEY"',
      'model = "deepseek-flash"',
      'name = "DeepSeek"',
      '',
      '[providers.deepseek.base_url]',
      'chat = "https://api.deepseek.com"',
      'messages = "https://api.deepseek.com/anthropic/v1"',
      '',
    ].join('\n'))
    expect(readAuth(fwtDirs(home))).toEqual({ deepseek: { api_key: 'sk-saved' } })
    expect((await stat(join(home, 'auth.json'))).mode & 0o777).toBe(0o600)
    expect(() => resolveModel({ home })).toThrow('No provider selected. Set "provider" in config.toml')

    const flash = await probe({ home, provider: 'deepseek' })
    expect(flash.url).toBe('https://api.deepseek.com/chat/completions')
    expect(flash.apiKey).toBe('sk-saved')
    expect(flash.headers.get('user-agent')).toBe(`fwt/${version}`)
    expect(flash.resolved).toMatchObject({
      contextTokens: 1_048_576,
      maxOutputTokens: 32_768,
      model: 'deepseek-flash',
      protocol: 'chat',
      provider: 'deepseek',
      supportsImageInput: true,
    })

    const viaMessages = await probe({ home, model: 'deepseek-flash', protocol: 'messages', provider: 'deepseek' })
    expect(viaMessages.url).toBe('https://api.deepseek.com/anthropic/v1/messages')

    const messagesOnly = await probe({ home, model: 'deepseek-messages-only', provider: 'deepseek' })
    expect(messagesOnly.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(messagesOnly.resolved).toMatchObject({ contextTokens: 250_000, maxOutputTokens: 32_768, supportsImageInput: false })
  })

  it('sends the OpenCode session header from a {session} template', async () => {
    const home = await makeHome()
    await addProvider({ apiKey: 'oc', fetch: modelsDevFetch(), home, io: createMemoryIo(), makeDefault: true, model: 'glm-5.3-flash', provider: 'opencode-go' })
    expect(readConfig(fwtDirs(home)).providers['opencode-go'].headers).toEqual({ 'x-opencode-session': '{session}' })

    const run = await probe({ headers: { 'User-Agent': 'custom/1', 'X-Extra': 'a-{session}' }, home })
    expect(run.headers.get('x-opencode-session')).toBe('session-1')
    expect(run.headers.get('x-extra')).toBe('a-session-1')
    expect(run.headers.get('user-agent')).toBe('custom/1')
  })

  it('revalidates the models.dev cache with ETag and falls back to it offline', async () => {
    const home = await makeHome()
    const calls: Request[] = []
    expect(Object.keys(await fetchCatalog(fwtDirs(home), { fetch: modelsDevFetch(calls) }) ?? {})).toEqual(['deepseek', 'opencode-go'])
    expect(Object.keys(await fetchCatalog(fwtDirs(home), { fetch: modelsDevFetch(calls) }) ?? {})).toEqual(['deepseek', 'opencode-go'])
    expect(calls.map(call => call.headers.get('if-none-match'))).toEqual([null, '"v1"'])

    const offline = await fetchCatalog(fwtDirs(home), { fetch: async () => Promise.reject(new Error('offline')) })
    expect(offline?.deepseek.base_url.chat).toBe('https://api.deepseek.com')
  })

  it('adds a manual provider interactively, listing models from the endpoint', async () => {
    const home = await makeHome()
    const stdin = new PassThrough()
    const io = createMemoryIo({ stdin })
    const seen: string[] = []
    const added = addProvider({
      fetch: async (request) => {
        seen.push(`${request.url} ${request.headers.get('authorization')}`)
        if (request.url.startsWith('https://models.dev/'))
          return new Response('down', { status: 503 })
        return Response.json({ data: [{ id: 'qwen-coder' }, { id: 'llama' }] })
      },
      home,
      io,
      provider: 'local',
    })
    stdin.end('responses\nhttps://local.example/v1\nlocal-key\n2\n\n')
    await added

    expect(io.stdout.text()).toContain('"local" is not on models.dev (unreachable); setting it up manually.')
    expect(io.stdout.text()).toContain('  1. llama\n  2. qwen-coder\n')
    expect(io.stdout.text()).toContain('Make local the default provider? [Y/n]: ')
    expect(seen.at(-1)).toBe('https://local.example/v1/models Bearer local-key')
    expect(readConfig(fwtDirs(home))).toEqual({
      provider: 'local',
      providers: { local: { base_url: { responses: 'https://local.example/v1' }, model: 'qwen-coder' } },
    })

    const run = await probe({ home })
    expect(run.url).toBe('https://local.example/v1/responses')
    expect(run.apiKey).toBe('local-key')
  })

  it('reads hand-written settings and applies key and effort precedence', async () => {
    const home = await makeHome()
    await writeFile(join(home, 'config.toml'), [
      'provider = "gateway"',
      '',
      '[providers.gateway]',
      'model = "coder"',
      'env_key = "GATEWAY_KEY"',
      'base_url = { messages = "https://gw.example/anthropic/v1", chat = "https://gw.example/v1" }',
      '',
      '[providers.gateway.models.coder]',
      'context = 65536',
      'effort = "high"',
      'image = false',
      'max_output = 8192',
      'protocol = "chat"',
    ].join('\n'))
    await writeFile(join(home, 'auth.json'), JSON.stringify({ gateway: { api_key: 'from-auth' } }))

    const fromAuth = await probe({ home })
    expect(fromAuth.url).toBe('https://gw.example/v1/chat/completions')
    expect(fromAuth.apiKey).toBe('from-auth')
    expect(fromAuth.body.reasoning_effort).toBe('high')
    expect(fromAuth.resolved).toMatchObject({ contextTokens: 65_536, maxOutputTokens: 8192, supportsImageInput: false })
    expect((await probe({ effort: 'max', home })).body.reasoning_effort).toBe('max')
    expect((await probe({ contextLength: 16_000, home })).resolved).toMatchObject({ contextTokens: 16_000, maxOutputTokens: 4000 })
    vi.stubEnv('FWT_CONTEXT_LENGTH', '1000000')
    expect((await probe({ home })).resolved).toMatchObject({ contextTokens: 1_000_000, maxOutputTokens: 8192 })
    expect((await probe({ contextLength: 128_000, home })).resolved.contextTokens).toBe(128_000)
    vi.stubEnv('FWT_CONTEXT_LENGTH', '250k')
    expect(() => resolveModel({ home })).toThrow('Invalid FWT_CONTEXT_LENGTH')
    vi.stubEnv('FWT_CONTEXT_LENGTH', '')

    const unknownModel = await probe({ home, model: 'other' })
    expect(unknownModel.url).toBe('https://gw.example/anthropic/v1/messages')

    vi.stubEnv('GATEWAY_KEY', 'from-env')
    expect((await probe({ home })).apiKey).toBe('from-env')
    vi.stubEnv('FWT_API_KEY', 'from-fwt-env')
    expect((await probe({ home })).apiKey).toBe('from-fwt-env')
    expect((await probe({ apiKey: 'from-flag', home })).apiKey).toBe('from-flag')
  })

  it('keeps configured providers out of a bare --base-url run', async () => {
    const home = await makeHome()
    await writeFile(join(home, 'config.toml'), [
      'provider = "gateway"',
      '[providers.gateway]',
      'model = "coder"',
      'base_url = { chat = "https://gw.example/v1" }',
      'headers = { x-gateway = "1" }',
    ].join('\n'))
    await writeFile(join(home, 'auth.json'), JSON.stringify({ gateway: { api_key: 'secret' } }))

    expect(() => resolveModel({ baseURL: 'https://elsewhere.example/v1', home })).toThrow('No model configured for provider "custom"')
    const adHoc = await probe({ baseURL: 'https://elsewhere.example/v1', home, model: 'foo', protocol: 'responses' })
    expect(adHoc.url).toBe('https://elsewhere.example/v1/responses')
    expect(adHoc.apiKey).toBeUndefined()
    expect(adHoc.headers.get('x-gateway')).toBeNull()
    expect(adHoc.resolved.provider).toBe('custom')

    const proxied = await probe({ baseURL: 'https://proxy.example/v1', home, provider: 'gateway' })
    expect(proxied.url).toBe('https://proxy.example/v1/chat/completions')
    expect(proxied.apiKey).toBe('secret')
    expect(proxied.headers.get('x-gateway')).toBe('1')
  })

  it('reports missing or invalid configuration clearly', async () => {
    const home = await makeHome()
    expect(() => resolveModel({ home, provider: 'nope' })).toThrow('Unknown provider "nope"')

    await writeFile(join(home, 'config.toml'), '[providers.bad]\nbase_url = { grpc = "x" }\n')
    expect(() => resolveModel({ home })).toThrow(`Invalid ${join(home, 'config.toml')} at providers.bad.base_url`)

    await writeFile(join(home, 'config.toml'), 'provider = "p"\n[providers.p]\nmodel = "m"\nbase_url = { chat = "https://p.example" }\n')
    expect(() => resolveModel({ home, protocol: 'responses' })).toThrow('Provider "p" has no base_url for protocol "responses" (configured: chat).')
    vi.stubEnv('FWT_PROTOCOL', 'grpc')
    expect(() => resolveModel({ home })).toThrow('Invalid FWT_PROTOCOL "grpc"')
  })

  it('lists and removes providers', async () => {
    const home = await makeHome()
    await addProvider({ apiKey: 'k1', fetch: modelsDevFetch(), home, io: createMemoryIo(), makeDefault: true, model: 'deepseek-flash', provider: 'deepseek' })
    await addProvider({ apiKey: '', baseURL: 'https://gateway.example/v1', home, io: createMemoryIo(), makeDefault: true, model: 'm', protocol: 'responses', provider: 'local' })

    const listIo = createMemoryIo()
    listProviders({ home, io: listIo })
    expect(listIo.stdout.text()).toBe([
      '  deepseek  chat, messages  saved key  model: deepseek-flash',
      '* local  responses  no key  model: m',
      '',
    ].join('\n'))

    const removeIo = createMemoryIo()
    await removeProvider({ home, io: removeIo, provider: 'local' })
    expect(removeIo.stdout.text()).toBe('Removed local. It was the default provider; no default is set now.\n')
    expect(readConfig(fwtDirs(home))).not.toHaveProperty('provider')
    expect(Object.keys(readConfig(fwtDirs(home)).providers)).toEqual(['deepseek'])
    await removeProvider({ home, io: createMemoryIo(), provider: 'deepseek' })
    expect(readAuth(fwtDirs(home))).toEqual({})
    await expect(removeProvider({ home, io: createMemoryIo(), provider: 'deepseek' })).rejects.toThrow('Unknown provider "deepseek".')
  })

  it('retries network errors, 429 and 5xx, honouring Retry-After, then gives up', async () => {
    const home = await makeHome()
    const send = async (replies: (() => Promise<Response> | Response)[]) => {
      let calls = 0
      const resolved = resolveModel({
        baseURL: 'https://retry.example/v1',
        fetch: async () => replies[Math.min(calls++, replies.length - 1)](),
        home,
        model: 'm',
      })
      const error = await generateText(resolved.languageModel('s'), {
        input: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
      }).then(() => undefined, (failure: unknown) => failure)
      return { calls, error }
    }
    const busy = () => new Response('busy', { headers: { 'retry-after': '0' }, status: 503 })

    const recovered = await send([
      async () => Promise.reject(new TypeError('fetch failed')),
      () => new Response('slow down', { headers: { 'retry-after': '0' }, status: 429 }),
      busy,
      () => new Response('bad request', { status: 400 }),
    ])
    expect(recovered.calls).toBe(4)
    expect(String(recovered.error)).toContain('400')

    const exhausted = await send([busy])
    expect(exhausted.calls).toBe(5)
    expect(String(exhausted.error)).toContain('503')
  })

  it('resumes with the recorded model unless a new provider, base URL or model is given', async () => {
    const home = await makeHome()
    await writeFile(join(home, 'config.toml'), [
      'provider = "b"',
      '[providers.a]',
      'model = "a-default"',
      'base_url = { chat = "https://a.example/v1", messages = "https://a.example/anthropic/v1" }',
      '[providers.b]',
      'model = "b-default"',
      'base_url = { responses = "https://b.example/v1" }',
    ].join('\n'))
    const recorded = { model: 'a-old', protocol: 'messages', provider: 'a' } as const

    expect(resolveRecordedModel({ home }, recorded)).toMatchObject(recorded)
    expect(resolveRecordedModel({ home, model: 'a-new' }, recorded)).toMatchObject({ model: 'a-new', protocol: 'chat', provider: 'a' })
    expect(resolveRecordedModel({ home, provider: 'b' }, recorded)).toMatchObject({ model: 'b-default', protocol: 'responses', provider: 'b' })
    expect(resolveRecordedModel({ baseURL: 'https://c.example/v1', home, model: 'c' }, recorded)).toMatchObject({ model: 'c', provider: 'custom' })
    expect(() => resolveRecordedModel({ home }, { model: 'x', protocol: 'chat', provider: 'custom' })).toThrow('pass --base-url (and --model) again')
  })
})
