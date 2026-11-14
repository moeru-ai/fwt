import type { FwtDirs } from '../home'
import type { WireProtocol } from './config'

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import * as v from 'valibot'

import { modelInfoSchema, positiveInteger, wireProtocolSchema } from './config'

const MODELS_DEV_URL = 'https://models.dev/experimental/v2.0/api.json?type=chat'

const MODELS_DEV_ROUTES: Readonly<Record<string, WireProtocol>> = {
  'chat-completions': 'chat',
  'messages': 'messages',
  'responses': 'responses',
}

const positiveLimit = v.fallback(v.optional(positiveInteger), undefined)

const rawModelSchema = v.looseObject({
  api: v.pipe(
    v.optional(v.record(v.string(), v.looseObject({ base_url: v.optional(v.string()) })), {}),
    v.transform(api => Object.entries(api).flatMap(([route, { base_url }]) => {
      const protocol = MODELS_DEV_ROUTES[route]
      return protocol != null && base_url != null ? [[protocol, base_url] as const] : []
    })),
  ),
  limit: v.optional(v.looseObject({ context: positiveLimit, output: positiveLimit }), {}),
  modalities: v.optional(v.looseObject({ input: v.optional(v.array(v.string()), []) }), {}),
  name: v.optional(v.string()),
})

const rawCatalogSchema = v.record(v.string(), v.looseObject({
  env: v.optional(v.array(v.string()), []),
  models: v.record(v.string(), rawModelSchema),
  name: v.string(),
}))

const catalogModelSchema = v.strictObject({
  ...v.omit(modelInfoSchema, ['effort', 'protocol']).entries,
  name: v.optional(v.string()),
  protocols: v.array(wireProtocolSchema),
})

const catalogProviderSchema = v.strictObject({
  base_url: v.record(wireProtocolSchema, v.string()),
  env: v.array(v.string()),
  models: v.record(v.string(), catalogModelSchema),
  name: v.string(),
})

const cacheSchema = v.strictObject({
  etag: v.optional(v.string()),
  providers: v.record(v.string(), catalogProviderSchema),
})

export type CatalogProvider = v.InferOutput<typeof catalogProviderSchema>

export type FetchFn = (request: Request) => Promise<Response>

type Catalog = v.InferOutput<typeof cacheSchema>['providers']

const cachePath = (dirs: FwtDirs): string => join(dirs.cache, 'models.dev.json')

const mostCommon = (values: readonly string[]): string | undefined => {
  const counts = new Map<string, number>()
  for (const value of values)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts].toSorted((a, b) => b[1] - a[1])[0]?.[0]
}

const trimCatalog = (raw: v.InferOutput<typeof rawCatalogSchema>): Catalog => {
  const providers: Catalog = {}
  for (const [id, provider] of Object.entries(raw)) {
    const models = Object.entries(provider.models).filter(([, model]) => model.api.length > 0)
    if (models.length === 0)
      continue
    const routes = models.flatMap(([, model]) => model.api)
    const nativeCount = (protocol: WireProtocol): number => models.filter(([, model]) => model.api[0][0] === protocol).length
    const protocols = wireProtocolSchema.options.toSorted((a, b) => nativeCount(b) - nativeCount(a))
    const baseURL = Object.fromEntries(protocols.flatMap((protocol) => {
      const url = mostCommon(routes.filter(([candidate]) => candidate === protocol).map(([, routeURL]) => routeURL))
      return url != null ? [[protocol, url]] : []
    }))
    providers[id] = {
      base_url: baseURL,
      env: provider.env,
      models: Object.fromEntries(models.map(([modelId, model]) => [modelId, {
        context: model.limit.context,
        image: model.modalities.input.some(input => input === 'image' || input.startsWith('image/')),
        max_output: model.limit.output,
        name: model.name,
        protocols: model.api.map(([protocol]) => protocol),
      }])),
      name: provider.name,
    }
  }
  return providers
}

const readCache = (dirs: FwtDirs): undefined | v.InferOutput<typeof cacheSchema> => {
  try {
    return v.parse(cacheSchema, JSON.parse(readFileSync(cachePath(dirs), 'utf8')))
  }
  catch {
    return undefined
  }
}

export const readCachedCatalog = (dirs: FwtDirs): Catalog | undefined => readCache(dirs)?.providers

export const fetchCatalog = async (
  dirs: FwtDirs,
  options: { fetch?: FetchFn, signal?: AbortSignal, url?: string } = {},
): Promise<Catalog | undefined> => {
  const cached = readCache(dirs)
  const fetchFn = options.fetch ?? globalThis.fetch
  const timeout = AbortSignal.timeout(15_000)
  let response: Response
  try {
    response = await fetchFn(new Request(options.url ?? MODELS_DEV_URL, {
      headers: cached?.etag != null ? { 'if-none-match': cached.etag } : {},
      signal: AbortSignal.any([timeout, options.signal].filter(signal => signal != null)),
    }))
  }
  catch {
    options.signal?.throwIfAborted()
    return cached?.providers
  }
  if (response.status === 304 || !response.ok)
    return cached?.providers

  const providers = trimCatalog(v.parse(rawCatalogSchema, await response.json()))
  const etag = response.headers.get('etag') ?? undefined
  await mkdir(dirname(cachePath(dirs)), { recursive: true })
  await writeFile(cachePath(dirs), JSON.stringify({ etag, providers }))
  return providers
}
