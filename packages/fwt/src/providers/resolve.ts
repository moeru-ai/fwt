import type { LanguageModel, TextEvent } from '@xsai/text'

import type { FetchFn } from './catalog'
import type { WireProtocol } from './config'

import process from 'node:process'

import { sleepWithAbort } from '@moeru/std'
import { chat } from '@xsai/text-chat'
import { messages } from '@xsai/text-messages'
import { responses } from '@xsai/text-responses'

import * as v from 'valibot'

import { version } from '../../package.json' with { type: 'json' }
import { fwtDirs } from '../home'
import { readCachedCatalog } from './catalog'
import { positiveInteger, readAuth, readConfig, wireProtocolSchema } from './config'

const DEFAULT_CONTEXT_TOKENS = 250_000
const MAX_OUTPUT_TOKENS = 32_768
const MAX_REQUEST_RETRIES = 4
const MAX_STREAM_RETRIES = 5
const MAX_RETRY_AFTER_MS = 60_000
const STREAM_IDLE_TIMEOUT_MS = 300_000

export interface ModelConfigInput {
  apiKey?: string
  baseURL?: string
  contextLength?: number
  effort?: string
  fetch?: FetchFn
  headers?: Record<string, string>
  home?: string
  model?: string
  protocol?: WireProtocol
  provider?: string
}

export interface ResolvedModelConfig {
  contextTokens: number
  effort?: string
  languageModel: (sessionId: string) => LanguageModel
  maxOutputTokens: number
  model: string
  protocol: WireProtocol
  provider: string
  supportsImageInput: boolean
}

const retryDelayMs = (attempt: number, response?: Response): number => {
  const retryAfter = response?.headers.get('retry-after')
  if (retryAfter != null) {
    const ms = /^\d+$/.test(retryAfter) ? Number.parseInt(retryAfter, 10) * 1000 : Date.parse(retryAfter) - Date.now()
    if (ms >= 0)
      return Math.min(ms, MAX_RETRY_AFTER_MS)
  }
  return 200 * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2)
}

const withRetry = (fetchFn: FetchFn): FetchFn => async (request) => {
  for (let attempt = 1; ; attempt += 1) {
    let response: Response
    try {
      response = await fetchFn(request.clone())
    }
    catch (error) {
      request.signal.throwIfAborted()
      if (attempt > MAX_REQUEST_RETRIES)
        throw error
      await sleepWithAbort(retryDelayMs(attempt), request.signal)
      continue
    }
    if (attempt > MAX_REQUEST_RETRIES || (response.status !== 429 && response.status < 500))
      return response
    await response.body?.cancel()
    await sleepWithAbort(retryDelayMs(attempt, response), request.signal)
  }
}

const withStreamIdleTimeout = (fetchFn: FetchFn): FetchFn => async (request) => {
  const controller = new AbortController()
  const signal = AbortSignal.any([request.signal, controller.signal])
  const response = await fetchFn(new Request(request, { signal }))
  if (response.body == null)
    return response

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      controller.abort(reason)
      await reader.cancel(reason)
    },
    pull: async (stream) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | undefined
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(signal.reason)
            signal.addEventListener('abort', abortListener, { once: true })
            timeout = setTimeout(() => {
              const error = new DOMException('Response body idle timeout', 'TimeoutError')
              controller.abort(error)
              reject(error)
            }, STREAM_IDLE_TIMEOUT_MS)
            if (signal.aborted)
              abortListener()
          }),
        ])
        if (chunk.done) {
          stream.close()
          return
        }
        stream.enqueue(chunk.value)
      }
      catch (error) {
        await reader.cancel(error).catch(() => {})
        stream.error(error)
      }
      finally {
        if (timeout != null)
          clearTimeout(timeout)
        if (abortListener != null)
          signal.removeEventListener('abort', abortListener)
      }
    },
  })
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

const retryableStreamError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error == null)
    return true
  if ('status' in error && typeof error.status === 'number')
    return error.status === 429 || error.status >= 500
  if ('code' in error && typeof error.code === 'string')
    return error.code === 'network-error' || error.code === 'truncated-stream'
  return true
}

interface StreamAttemptFailure {
  error: unknown
  event?: Extract<TextEvent, { type: 'step.end' }>
}

const failedStepEvent = (event: TextEvent): StreamAttemptFailure | undefined =>
  event.type === 'step.end' && event.status === 'failed' ? { error: event.error, event } : undefined

const readStreamAttempt = async function* (
  stream: ReadableStream<TextEvent>,
  attempt: number,
): AsyncGenerator<TextEvent, StreamAttemptFailure | undefined> {
  const reader = stream.getReader()
  let pendingContent: Extract<TextEvent, { type: 'content.end' }>[] = []
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done)
        return undefined
      const event = chunk.value
      const failure = failedStepEvent(event)
      if (failure != null)
        return failure
      if (event.type === 'content.end') {
        pendingContent.push(event)
        continue
      }
      if (event.type === 'step.start' && attempt > 1)
        continue
      if (event.type === 'step.end') {
        for (const content of pendingContent)
          yield content
        pendingContent = []
      }
      yield event
    }
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const withStreamRetry = (model: LanguageModel): LanguageModel => (options) => {
  const signal = options.signal ?? new AbortController().signal
  const generate = async function* (): AsyncGenerator<TextEvent> {
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted()
      const stream = await model(options)
      let failure: StreamAttemptFailure | undefined
      try {
        failure = yield* readStreamAttempt(stream, attempt)
      }
      catch (error) {
        failure = { error }
      }
      if (failure == null)
        return
      signal.throwIfAborted()
      if (!retryableStreamError(failure.error) || attempt > MAX_STREAM_RETRIES) {
        if (failure.event != null)
          yield failure.event
        else
          throw failure.error
        return
      }
      await sleepWithAbort(retryDelayMs(attempt), signal)
    }
  }
  const source = generate()
  return new ReadableStream<TextEvent>({
    cancel: async (reason) => {
      await source.return(reason as never)
    },
    pull: async (stream) => {
      try {
        const chunk = await source.next()
        if (chunk.done)
          stream.close()
        else
          stream.enqueue(chunk.value)
      }
      catch (error) {
        stream.error(error)
      }
    },
  }, { highWaterMark: 0 })
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value != null && value !== '' ? value : undefined

const envContextLength = (): number | undefined => {
  const raw = nonEmpty(process.env.FWT_CONTEXT_LENGTH)
  if (raw == null)
    return undefined
  const result = v.safeParse(v.pipe(v.string(), v.toNumber(), positiveInteger), raw)
  if (!result.success)
    throw new Error(`Invalid FWT_CONTEXT_LENGTH "${raw}". Expected a positive integer.`)
  return result.output
}

const LANGUAGE_MODELS = { chat, messages, responses } satisfies Record<WireProtocol, unknown>

export const resolveModel = (input: ModelConfigInput = {}): ResolvedModelConfig => {
  const dirs = fwtDirs(input.home)
  const config = readConfig(dirs)
  const envProtocol = nonEmpty(process.env.FWT_PROTOCOL)
  if (envProtocol != null && !v.is(wireProtocolSchema, envProtocol))
    throw new Error(`Invalid FWT_PROTOCOL "${envProtocol}". Expected chat, responses, or messages.`)

  const baseURLOverride = nonEmpty(input.baseURL) ?? nonEmpty(process.env.FWT_BASE_URL)
  const namedProvider = nonEmpty(input.provider) ?? nonEmpty(process.env.FWT_PROVIDER)
  const adHoc = namedProvider == null && baseURLOverride != null
  const provider = adHoc ? 'custom' : namedProvider ?? config.provider
  if (provider == null)
    throw new Error('No provider selected. Set "provider" in config.toml, or pass --provider or --base-url.')

  const providerConfig = adHoc ? undefined : config.providers[provider]
  if (providerConfig == null && baseURLOverride == null)
    throw new Error(`Unknown provider "${provider}". Run "fwt provider add ${provider}" or pass --base-url.`)

  const model = nonEmpty(input.model)
    ?? nonEmpty(process.env.FWT_MODEL)
    ?? providerConfig?.model
  if (model == null)
    throw new Error(`No model configured for provider "${provider}". Pass --model or set "model" under [providers.${provider}] in config.toml.`)

  const baseURLs = providerConfig?.base_url ?? {}
  const catalogModel = adHoc ? undefined : readCachedCatalog(dirs)?.[provider]?.models[model]
  const info = { ...catalogModel, ...providerConfig?.models?.[model] }
  const protocol = input.protocol
    ?? envProtocol
    ?? info.protocol
    ?? catalogModel?.protocols.find(candidate => baseURLOverride != null || baseURLs[candidate] != null)
    ?? (Object.keys(baseURLs) as WireProtocol[])[0]
    ?? 'chat'

  const baseURL = baseURLOverride ?? baseURLs[protocol]
  if (baseURL == null)
    throw new Error(`Provider "${provider}" has no base_url for protocol "${protocol}" (configured: ${Object.keys(baseURLs).join(', ')}).`)

  const envKey = providerConfig?.env_key
  const apiKey = nonEmpty(input.apiKey)
    ?? nonEmpty(process.env.FWT_API_KEY)
    ?? (envKey != null ? nonEmpty(process.env[envKey]) : undefined)
    ?? (adHoc ? undefined : readAuth(dirs)[provider]?.api_key)
  const contextTokens = input.contextLength
    ?? envContextLength()
    ?? info.context
    ?? DEFAULT_CONTEXT_TOKENS
  const headers = Object.entries({ 'user-agent': `fwt/${version}`, ...providerConfig?.headers, ...input.headers })

  return {
    contextTokens,
    effort: nonEmpty(input.effort) ?? nonEmpty(process.env.FWT_EFFORT) ?? info.effort,
    languageModel: sessionId => withStreamRetry(LANGUAGE_MODELS[protocol]({
      apiKey,
      baseURL,
      fetch: withRetry(withStreamIdleTimeout(input.fetch ?? globalThis.fetch)),
      headers: Object.fromEntries(headers.map(([name, value]) => [name.toLowerCase(), value.replaceAll('{session}', sessionId)])),
      model,
    })),
    maxOutputTokens: Math.min(info.max_output ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS, Math.floor(contextTokens / 4)),
    model,
    protocol,
    provider,
    supportsImageInput: info.image ?? true,
  }
}

export const resolveRecordedModel = (
  input: ModelConfigInput,
  recorded: Pick<ResolvedModelConfig, 'model' | 'protocol' | 'provider'>,
): ResolvedModelConfig => {
  const switchesEndpoint = (nonEmpty(input.provider) ?? nonEmpty(process.env.FWT_PROVIDER)
    ?? nonEmpty(input.baseURL) ?? nonEmpty(process.env.FWT_BASE_URL)) != null
  if (switchesEndpoint)
    return resolveModel(input)
  if (recorded.provider === 'custom')
    throw new Error('The session used an ad-hoc --base-url; pass --base-url (and --model) again to resume it.')
  const newModel = nonEmpty(input.model) ?? nonEmpty(process.env.FWT_MODEL)
  return resolveModel({
    ...input,
    model: newModel ?? recorded.model,
    protocol: input.protocol ?? (newModel == null && nonEmpty(process.env.FWT_PROTOCOL) == null ? recorded.protocol : undefined),
    provider: recorded.provider,
  })
}
