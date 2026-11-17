import type { Message, Usage } from '@xsai/text'

import type { WireProtocol } from '../providers'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import * as v from 'valibot'

import { wireProtocolSchema } from '../providers'

const CACHE_MISS_NOISE_FLOOR_TOKENS = 1024

export interface CacheStats {
  record: (usage: Usage, stepNumber: number) => CacheMissEvent | undefined
  recordCompaction: (usage: Usage) => void
  snapshot: () => CacheStatsSnapshot
}

export interface CacheStatsSnapshot {
  hitRate: number
  lastInputTokens: number
  misses: readonly CacheMissEvent[]
  steps: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalInputTokens: number
  totalOutputTokens: number
}

export interface SessionStore {
  appendCompaction: (record: Omit<SessionCompactionRecord, 'timestamp' | 'type'>) => Promise<void>
  appendMessage: (message: Message) => Promise<void>
  appendUsage: (record: Omit<SessionUsageRecord, 'cacheMiss' | 'timestamp' | 'type'>) => Promise<CacheMissEvent | undefined>
  cacheStats: CacheStats
  compaction: () => SessionCompactionRecord | undefined
  filePath: string
  flush: () => Promise<void>
  header: SessionHeader
  id: string
  messages: () => readonly Message[]
  records: () => readonly (SessionCompactionRecord | SessionMessageRecord)[]
  usageBaseline: () => undefined | UsageBaseline
}

interface CreateSessionStoreOptions {
  cwd: string
  id?: string
  model: string
  protocol: WireProtocol
  provider: string
  sessionsDir: string
}

interface UsageBaseline {
  inputTokens: number
  messageCount: number
}

const cacheMissSchema = v.object({
  actualCacheReadTokens: v.number(),
  expectedCachedTokens: v.number(),
  missedTokens: v.number(),
  stepNumber: v.number(),
})

const usageSchema = v.object({
  cacheCreationInputTokens: v.optional(v.number()),
  cacheReadInputTokens: v.optional(v.number()),
  inputTokens: v.number(),
  outputTokens: v.number(),
  reasoningTokens: v.optional(v.number()),
  totalTokens: v.number(),
})

const safeParseJson = (line: string): unknown => {
  try {
    return JSON.parse(line)
  }
  catch {
    return undefined
  }
}

const sessionHeaderSchema = v.object({
  createdAt: v.string(),
  cwd: v.string(),
  id: v.string(),
  model: v.string(),
  protocol: wireProtocolSchema,
  provider: v.string(),
  type: v.literal('session'),
})

const sessionMessageSchema = v.object({
  message: v.looseObject({
    content: v.union([v.string(), v.array(v.unknown())]),
    role: v.picklist(['assistant', 'developer', 'system', 'user']),
  }),
  timestamp: v.string(),
  type: v.literal('message'),
})

const sessionUsageSchema = v.object({
  cacheMiss: v.optional(cacheMissSchema),
  model: v.optional(v.string()),
  stepNumber: v.number(),
  timestamp: v.string(),
  type: v.literal('usage'),
  usage: usageSchema,
})

const sessionCompactionSchema = v.object({
  summary: v.string(),
  tailStartMessage: v.pipe(v.number(), v.integer(), v.minValue(0)),
  timestamp: v.string(),
  type: v.literal('compaction'),
  usage: usageSchema,
})

const sessionRecordSchema = v.variant('type', [
  sessionHeaderSchema,
  sessionMessageSchema,
  sessionCompactionSchema,
  sessionUsageSchema,
])

export type CacheMissEvent = v.InferOutput<typeof cacheMissSchema>

export type SessionCompactionRecord = v.InferOutput<typeof sessionCompactionSchema>

export type SessionHeader = v.InferOutput<typeof sessionHeaderSchema>

type SessionMessageRecord = Omit<v.InferOutput<typeof sessionMessageSchema>, 'message'> & { message: Message }

type SessionRecord = SessionCompactionRecord | SessionHeader | SessionMessageRecord | SessionUsageRecord

type SessionUsageRecord = v.InferOutput<typeof sessionUsageSchema>

export const createCacheStats = (): CacheStats => {
  let lastInputTokens = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let steps = 0
  const misses: CacheMissEvent[] = []

  const add = (usage: Usage): void => {
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    totalCacheReadTokens += usage.cacheReadInputTokens ?? 0
    totalCacheCreationTokens += usage.cacheCreationInputTokens ?? 0
    steps += 1
  }

  const record = (usage: Usage, stepNumber: number): CacheMissEvent | undefined => {
    add(usage)
    const cacheRead = usage.cacheReadInputTokens ?? 0
    const missedTokens = Math.max(0, lastInputTokens - cacheRead)
    const miss = lastInputTokens > CACHE_MISS_NOISE_FLOOR_TOKENS && missedTokens > CACHE_MISS_NOISE_FLOOR_TOKENS
      ? { actualCacheReadTokens: cacheRead, expectedCachedTokens: lastInputTokens, missedTokens, stepNumber }
      : undefined
    if (miss != null)
      misses.push(miss)
    lastInputTokens = usage.inputTokens
    return miss
  }

  const recordCompaction = (usage: Usage): void => {
    add(usage)
    lastInputTokens = 0
  }

  const snapshot = (): CacheStatsSnapshot => ({
    hitRate: totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : 0,
    lastInputTokens,
    misses: [...misses],
    steps,
    totalCacheCreationTokens,
    totalCacheReadTokens,
    totalInputTokens,
    totalOutputTokens,
  })

  return { record, recordCompaction, snapshot }
}

const buildSessionStore = (header: SessionHeader, filePath: string): SessionStore & { apply: (record: SessionRecord) => CacheMissEvent | undefined } => {
  const cacheStats = createCacheStats()
  const messages: Message[] = []
  const records: (SessionCompactionRecord | SessionMessageRecord)[] = []
  let compaction: SessionCompactionRecord | undefined
  let usageBaseline: undefined | UsageBaseline
  let writeQueue = Promise.resolve()

  const apply = (record: SessionRecord): CacheMissEvent | undefined => {
    switch (record.type) {
      case 'compaction':
        records.push(record)
        compaction = record
        usageBaseline = undefined
        cacheStats.recordCompaction(record.usage)
        return undefined
      case 'message':
        records.push(record)
        messages.push(record.message)
        return undefined
      case 'session':
        return undefined
      case 'usage': {
        const previous = records.at(-1)
        const repliedTo = previous?.type === 'message' && previous.message.role === 'assistant'
        usageBaseline = { inputTokens: record.usage.inputTokens, messageCount: messages.length - (repliedTo ? 1 : 0) }
        return cacheStats.record(record.usage, record.stepNumber)
      }
    }
  }

  const write = async (record: SessionRecord): Promise<void> => {
    const next = writeQueue.then(async () => appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8'))
    writeQueue = next.catch(() => {})
    await next
  }

  return {
    appendCompaction: async (entry) => {
      const record: SessionCompactionRecord = { ...entry, timestamp: new Date().toISOString(), type: 'compaction' }
      await write(record)
      apply(record)
    },
    appendMessage: async (message) => {
      const record: SessionMessageRecord = { message, timestamp: new Date().toISOString(), type: 'message' }
      await write(record)
      apply(record)
    },
    appendUsage: async (entry) => {
      const record: SessionUsageRecord = { ...entry, timestamp: new Date().toISOString(), type: 'usage' }
      const cacheMiss = apply(record)
      await write(cacheMiss == null ? record : { ...record, cacheMiss })
      return cacheMiss
    },
    apply,
    cacheStats,
    compaction: () => compaction,
    filePath,
    flush: async () => writeQueue,
    header,
    id: header.id,
    messages: () => messages,
    records: () => records,
    usageBaseline: () => usageBaseline,
  }
}

export const createSessionStore = async (options: CreateSessionStoreOptions): Promise<SessionStore> => {
  const id = options.id ?? randomUUID()
  const timestampSlug = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const filePath = join(options.sessionsDir, `${timestampSlug}_${id}.jsonl`)

  const header: SessionHeader = {
    createdAt: new Date().toISOString(),
    cwd: options.cwd,
    id,
    model: options.model,
    protocol: options.protocol,
    provider: options.provider,
    type: 'session',
  }

  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(header)}\n`, 'utf8')

  return buildSessionStore(header, filePath)
}

export const forkSessionStore = async (
  source: SessionStore,
  options: { cwd?: string, model?: string, protocol?: WireProtocol, provider?: string, sessionsDir: string },
): Promise<SessionStore> => {
  const fork = await createSessionStore({
    cwd: options.cwd ?? source.header.cwd,
    model: options.model ?? source.header.model,
    protocol: options.protocol ?? source.header.protocol,
    provider: options.provider ?? source.header.provider,
    sessionsDir: options.sessionsDir,
  })
  for (const record of source.records()) {
    if (record.type === 'message')
      await fork.appendMessage(record.message)
    else
      await fork.appendCompaction({ summary: record.summary, tailStartMessage: record.tailStartMessage, usage: record.usage })
  }
  return fork
}

export const listSessionHeaders = async (sessionsDir: string): Promise<{ filePath: string, header: SessionHeader, updatedAt: Date }[]> => {
  if (!existsSync(sessionsDir))
    return []
  const names = (await readdir(sessionsDir)).filter(name => name.endsWith('.jsonl'))
  const found = await Promise.all(names.map(async (name) => {
    const handle = await open(join(sessionsDir, name))
    try {
      const first = await handle.readLines()[Symbol.asyncIterator]().next()
      const parsed = v.safeParse(sessionHeaderSchema, safeParseJson(first.value ?? ''))
      return parsed.success ? { filePath: join(sessionsDir, name), header: parsed.output, updatedAt: (await handle.stat()).mtime } : undefined
    }
    finally {
      await handle.close()
    }
  }))
  return found
    .filter(entry => entry != null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

const findSessionFile = async (idOrPath: string, sessionsDir: string, latestCwd: string): Promise<string> => {
  if (idOrPath.includes('/') || idOrPath.includes('\\') || idOrPath.endsWith('.jsonl')) {
    const resolved = resolve(idOrPath)
    if (!existsSync(resolved))
      throw new Error(`Session file not found: ${resolved}`)
    return resolved
  }

  if (idOrPath === 'latest') {
    const cwdSessions = (await listSessionHeaders(sessionsDir))
      .filter(entry => entry.header.cwd === latestCwd)
    if (cwdSessions.length === 0)
      throw new Error(`No session found for working directory "${latestCwd}".`)
    return cwdSessions[0].filePath
  }

  if (!existsSync(sessionsDir))
    throw new Error(`Sessions directory not found: ${sessionsDir}`)

  const entries = (await readdir(sessionsDir)).filter(name => name.endsWith('.jsonl'))
  if (entries.length === 0)
    throw new Error(`No session files found in ${sessionsDir}`)

  const exact = entries.find(name => name === `${idOrPath}.jsonl` || name.endsWith(`_${idOrPath}.jsonl`))
  if (exact != null)
    return join(sessionsDir, exact)

  const partialMatches = entries.filter(name => name.includes(idOrPath))
  if (partialMatches.length === 1)
    return join(sessionsDir, partialMatches[0])
  if (partialMatches.length > 1)
    throw new Error(`Ambiguous session ID "${idOrPath}"; matched ${partialMatches.length} files.`)

  throw new Error(`Session "${idOrPath}" not found in ${sessionsDir}`)
}

export const openSessionStore = async (idOrPath: string, sessionsDir: string, latestCwd = process.cwd()): Promise<SessionStore> => {
  const filePath = await findSessionFile(idOrPath, sessionsDir, latestCwd)
  const raw = await readFile(filePath, 'utf8')
  const hasIncompleteLastLine = raw !== '' && !raw.endsWith('\n')
  const lines = raw.split(/\r?\n/)
  if (hasIncompleteLastLine && safeParseJson(lines.at(-1) ?? '') === undefined)
    lines.pop()
  const completeLines = lines.filter(line => line.trim() !== '')

  const parsed = completeLines.map((line, index) => {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(line)
    }
    catch (error) {
      throw new Error(`Invalid JSON on line ${index + 1} of session "${filePath}".`, { cause: error })
    }
    const result = v.safeParse(sessionRecordSchema, parsedJson)
    if (!result.success)
      throw new Error(`Invalid session record on line ${index + 1} of session "${filePath}".`)
    return result.output as SessionRecord
  })

  const header = parsed.find(record => record.type === 'session')
  if (header == null)
    throw new Error(`Session file "${filePath}" is missing its session header record.`)

  const store = buildSessionStore(header, filePath)
  for (const record of parsed)
    store.apply(record)
  return store
}
