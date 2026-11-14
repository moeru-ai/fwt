import type { CatalogProvider, FetchFn } from './catalog'
import type { ProviderConfig, WireProtocol } from './config'

import process from 'node:process'

import { createInterface } from 'node:readline/promises'

import * as v from 'valibot'

import { fwtDirs } from '../home'
import { fetchCatalog } from './catalog'
import { readAuth, readConfig, wireProtocolSchema, writeAuth, writeConfig } from './config'

const DISPLAY_MODEL_LIMIT = 15

const OPENCODE_HEADERS = { 'x-opencode-session': '{session}' }

const CATALOG_HEADERS: Readonly<Record<string, Record<string, string>>> = {
  'opencode': OPENCODE_HEADERS,
  'opencode-go': OPENCODE_HEADERS,
}

interface AddProviderOptions {
  apiKey?: string
  baseURL?: string
  fetch?: FetchFn
  home?: string
  io: ProviderIo
  makeDefault?: boolean
  model?: string
  modelsDevUrl?: string
  protocol?: WireProtocol
  provider?: string
  signal?: AbortSignal
}

type Ask = (label: string) => Promise<string>

interface ProviderIo {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: { write: (chunk: string) => unknown }
}

const readSecretTty = async (
  stdin: NodeJS.ReadableStream & { isRaw?: boolean, setRawMode: (mode: boolean) => void },
  stdout: ProviderIo['stdout'],
): Promise<string> => new Promise<string>((resolveSecret, rejectSecret) => {
  const wasRaw = stdin.isRaw === true
  const decoder = new TextDecoder()
  let buffer = ''
  let finish = (_error?: Error): void => {}
  const onData = (chunk: string | Uint8Array): void => {
    for (const ch of typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })) {
      if (ch === '\r' || ch === '\n')
        return finish()
      if (ch === '\u0003')
        return finish(new Error('Cancelled.'))
      if (ch === '\u007F' || ch === '\b') {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1)
          stdout.write('\b \b')
        }
        continue
      }
      buffer += ch
      stdout.write('*')
    }
  }
  finish = (error) => {
    stdin.off('data', onData)
    stdin.setRawMode(wasRaw)
    stdout.write('\n')
    if (error == null)
      resolveSecret(buffer.trim())
    else
      rejectSecret(error)
  }
  stdin.setRawMode(true)
  stdin.resume()
  stdin.on('data', onData)
})

const createPrompter = (io: ProviderIo) => {
  const input = io.stdin ?? process.stdin
  let lines: AsyncIterator<string> | undefined
  let rl: ReturnType<typeof createInterface> | undefined

  const ask: Ask = async (label) => {
    io.stdout.write(label)
    if (rl == null) {
      rl = createInterface({ crlfDelay: Infinity, input })
      lines = rl[Symbol.asyncIterator]()
    }
    const next = await lines!.next()
    if (next.done === true)
      throw new Error('Input ended before setup completed.')
    return next.value.trim()
  }

  const askSecret: Ask = async (label) => {
    if (input.isTTY !== true || !('setRawMode' in input) || typeof input.setRawMode !== 'function')
      return ask(label)
    io.stdout.write(label)
    rl?.pause()
    try {
      return await readSecretTty(input, io.stdout)
    }
    finally {
      rl?.resume()
    }
  }

  return { ask, askSecret, close: () => rl?.close() }
}

const listEndpointModels = async (options: {
  apiKey?: string
  baseURL: string
  fetch?: FetchFn
  protocol: WireProtocol
  signal?: AbortSignal
}): Promise<string[]> => {
  const headers = new Headers()
  if (options.apiKey != null && options.protocol === 'messages') {
    headers.set('x-api-key', options.apiKey)
    headers.set('anthropic-version', '2023-06-01')
  }
  else if (options.apiKey != null) {
    headers.set('authorization', `Bearer ${options.apiKey}`)
  }
  const timeout = AbortSignal.timeout(5000)
  try {
    const response = await (options.fetch ?? globalThis.fetch)(new Request(new URL('models', `${options.baseURL.replace(/\/$/, '')}/`), {
      headers,
      signal: AbortSignal.any([timeout, options.signal].filter(signal => signal != null)),
    }))
    if (!response.ok)
      return []
    const result = v.safeParse(
      v.object({ data: v.array(v.object({ id: v.string() })) }),
      await response.json(),
    )
    return result.success ? result.output.data.map(model => model.id).toSorted((a, b) => a.localeCompare(b)) : []
  }
  catch {
    options.signal?.throwIfAborted()
    return []
  }
}

const setUpEntry = async (
  id: string,
  existing: ProviderConfig | undefined,
  catalogProvider: CatalogProvider | undefined,
  options: AddProviderOptions,
  ask: Ask,
): Promise<ProviderConfig> => {
  if (catalogProvider != null) {
    if (options.protocol != null)
      throw new Error('--protocol applies only to providers set up with --base-url.')
    return {
      ...existing,
      base_url: catalogProvider.base_url,
      env_key: catalogProvider.env[0],
      headers: existing?.headers ?? CATALOG_HEADERS[id],
      name: catalogProvider.name,
    }
  }
  const protocol = options.protocol
    ?? v.parse(wireProtocolSchema, await ask('Protocol [chat/responses/messages] (chat): ') || 'chat')
  const baseURL = options.baseURL ?? await ask('Base URL: ')
  return { ...existing, base_url: { [protocol]: baseURL } }
}

const chooseModel = async (
  models: readonly string[],
  preferred: string | undefined,
  io: ProviderIo,
  ask: Ask,
): Promise<string> => {
  const fallback = preferred ?? models[0]
  const shown = models.slice(0, DISPLAY_MODEL_LIMIT)
  shown.forEach((name, index) => io.stdout.write(`  ${index + 1}. ${name}\n`))
  if (models.length > shown.length)
    io.stdout.write(`  ... and ${models.length - shown.length} more; type any model ID.\n`)
  const range = shown.length > 0 ? ` [1-${shown.length} or ID]` : ' ID'
  const answer = await ask(`Model${range}${fallback != null ? ` (${fallback})` : ''}: `)
  const index = Number.parseInt(answer, 10)
  const model = answer === ''
    ? fallback
    : String(index) === answer && index >= 1 && index <= shown.length ? shown[index - 1] : answer
  if (model == null)
    throw new Error('Model ID is required.')
  return model
}

export const addProvider = async (options: AddProviderOptions): Promise<void> => {
  const dirs = fwtDirs(options.home)
  const config = readConfig(dirs)
  const auth = readAuth(dirs)
  const { io } = options
  const prompter = createPrompter(io)

  try {
    const id = options.provider ?? await prompter.ask('Provider ID (a models.dev ID such as deepseek, or a new name): ')
    if (id === '')
      throw new Error('Provider ID is required.')

    const catalog = options.baseURL == null
      ? await fetchCatalog(dirs, { fetch: options.fetch, signal: options.signal, url: options.modelsDevUrl })
      : undefined
    const catalogProvider = catalog?.[id]
    if (catalogProvider == null && options.baseURL == null)
      io.stdout.write(`"${id}" is not on models.dev${catalog == null ? ' (unreachable)' : ''}; setting it up manually.\n`)
    const entry = await setUpEntry(id, config.providers[id], catalogProvider, options, prompter.ask)

    const envKey = entry.env_key
    const hint = auth[id] != null
      ? 'empty keeps the saved key'
      : envKey != null && process.env[envKey] != null ? `empty uses $${envKey}` : 'empty for none'
    const apiKey = options.apiKey ?? await prompter.askSecret(`API key (${hint}): `)
    if (apiKey !== '')
      auth[id] = { api_key: apiKey }

    const [protocol, baseURL] = Object.entries(entry.base_url)[0] as [WireProtocol, string]
    const model = options.model ?? await chooseModel(
      catalogProvider != null
        ? Object.keys(catalogProvider.models).toSorted((a, b) => a.localeCompare(b))
        : await listEndpointModels({ apiKey: auth[id]?.api_key, baseURL, fetch: options.fetch, protocol, signal: options.signal }),
      entry.model,
      io,
      prompter.ask,
    )

    const suggestDefault = config.provider == null || config.provider === id
    const makeDefault = options.makeDefault ?? await prompter
      .ask(`Make ${id} the default provider? [${suggestDefault ? 'Y/n' : 'y/N'}]: `)
      .then(answer => answer === '' ? suggestDefault : /^y(?:es)?$/i.test(answer))

    await writeConfig(dirs, {
      ...config,
      provider: makeDefault ? id : config.provider,
      providers: { ...config.providers, [id]: { ...entry, model } },
    })
    await writeAuth(dirs, auth)
    io.stdout.write(`Added ${entry.name ?? id} (${id}) with model ${model}${makeDefault ? ' as the default provider' : ''}.\n`)
  }
  finally {
    prompter.close()
  }
}

export const listProviders = ({ home, io }: { home?: string, io: ProviderIo }): void => {
  const dirs = fwtDirs(home)
  const config = readConfig(dirs)
  const auth = readAuth(dirs)
  const entries = Object.entries(config.providers)
  if (entries.length === 0) {
    io.stdout.write('No providers configured. Run "fwt provider add".\n')
    return
  }
  for (const [id, provider] of entries) {
    const key = auth[id] != null ? 'saved key' : provider.env_key != null ? `$${provider.env_key}` : 'no key'
    const model = provider.model != null ? `  model: ${provider.model}` : ''
    io.stdout.write(`${id === config.provider ? '*' : ' '} ${id}  ${Object.keys(provider.base_url).join(', ')}  ${key}${model}\n`)
  }
}

export const removeProvider = async ({ home, io, provider: id }: { home?: string, io: ProviderIo, provider: string }): Promise<void> => {
  const dirs = fwtDirs(home)
  const config = readConfig(dirs)
  const auth = readAuth(dirs)
  if (config.providers[id] == null && auth[id] == null)
    throw new Error(`Unknown provider "${id}".`)
  const without = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => key !== id))
  const isDefault = config.provider === id
  await writeConfig(dirs, { provider: isDefault ? undefined : config.provider, providers: without(config.providers) })
  await writeAuth(dirs, without(auth))
  io.stdout.write(`Removed ${id}.${isDefault ? ' It was the default provider; no default is set now.' : ''}\n`)
}
