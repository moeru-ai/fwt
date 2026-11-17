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
  appendMessage: (message: Message) => Promise<void>
  appendUsage: (record: Omit<SessionUsageRecord, 'timestamp' | 'type'>) => Promise<void>
  cacheStats: CacheStats
  filePath: string
  flush: () => Promise<void>
  header: SessionHeader
  id: string
  messages: () => readonly Message[]
}

interface CreateSessionStoreOptions {
  cwd: string
  id?: string
  model: string
  protocol: WireProtocol
  provider: string
  sessionsDir: string
}

interface SessionMessageRecord {
  message: Message
  timestamp: string
  type: 'message'
}

type SessionRecord = SessionHeader | SessionMessageRecord | SessionUsageRecord

interface SessionUsageRecord {
  cacheMiss?: CacheMissEvent
  model?: string
  stepNumber: number
  timestamp: string
  type: 'usage'
  usage: Usage
}

const cacheMissSchema = v.object({
  actualCacheReadTokens: v.number(),
  expectedCachedTokens: v.number(),
  missedTokens: v.number(),
  stepNumber: v.number(),
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
  version: v.literal(1),
})

export type CacheMissEvent = v.InferOutput<typeof cacheMissSchema>

export type SessionHeader = v.InferOutput<typeof sessionHeaderSchema>

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
  usage: v.looseObject({
    cacheCreationInputTokens: v.optional(v.number()),
    cacheReadInputTokens: v.optional(v.number()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    reasoningTokens: v.optional(v.number()),
    totalTokens: v.number(),
  }),
})

const sessionRecordSchema = v.variant('type', [
  sessionHeaderSchema,
  sessionMessageSchema,
  sessionUsageSchema,
])

export const createCacheStats = (): CacheStats => {
  let lastInputTokens = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let steps = 0
  const misses: CacheMissEvent[] = []

  const record = (usage: Usage, stepNumber: number): CacheMissEvent | undefined => {
    const cacheRead = usage.cacheReadInputTokens ?? 0
    const cacheCreate = usage.cacheCreationInputTokens ?? 0
    totalInputTokens += usage.inputTokens
    totalOutputTokens += usage.outputTokens
    totalCacheReadTokens += cacheRead
    totalCacheCreationTokens += cacheCreate
    steps += 1

    let miss: CacheMissEvent | undefined
    if (lastInputTokens > CACHE_MISS_NOISE_FLOOR_TOKENS) {
      const missedTokens = Math.max(0, lastInputTokens - cacheRead)
      if (missedTokens > CACHE_MISS_NOISE_FLOOR_TOKENS) {
        miss = {
          actualCacheReadTokens: cacheRead,
          expectedCachedTokens: lastInputTokens,
          missedTokens,
          stepNumber,
        }
        misses.push(miss)
      }
    }

    lastInputTokens = usage.inputTokens
    return miss
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

  return { record, snapshot }
}

const buildSessionStore = (
  header: SessionHeader,
  filePath: string,
  initialMessages: Message[],
  cacheStats: CacheStats,
): SessionStore => {
  const storedMessages = [...initialMessages]
  let writeQueue = Promise.resolve()

  const enqueueLine = async (record: SessionRecord): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`
    const next = writeQueue.then(async () => appendFile(filePath, line, 'utf8'))
    writeQueue = next.catch(() => {})
    await next
  }

  const appendMessage = async (message: Message): Promise<void> => {
    storedMessages.push(message)
    await enqueueLine({
      message,
      timestamp: new Date().toISOString(),
      type: 'message',
    })
  }

  const appendUsage = async (entry: Omit<SessionUsageRecord, 'timestamp' | 'type'>): Promise<void> => {
    await enqueueLine({
      ...entry,
      timestamp: new Date().toISOString(),
      type: 'usage',
    })
  }

  const flush = async (): Promise<void> => writeQueue

  return {
    appendMessage,
    appendUsage,
    cacheStats,
    filePath,
    flush,
    header,
    id: header.id,
    messages: () => storedMessages,
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
    version: 1,
  }

  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(header)}\n`, 'utf8')

  return buildSessionStore(header, filePath, [], createCacheStats())
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
  for (const message of source.messages())
    await fork.appendMessage(message)
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
  const lines = raw.split(/\r?\n/).filter(line => line.trim() !== '')

  let header: SessionHeader | undefined
  const messages: Message[] = []
  const cacheStats = createCacheStats()

  for (const [index, line] of lines.entries()) {
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

    const record = result.output
    switch (record.type) {
      case 'message':
        messages.push(record.message as Message)
        break
      case 'session':
        header = record
        break
      case 'usage':
        cacheStats.record(record.usage, record.stepNumber)
        break
    }
  }

  if (header == null)
    throw new Error(`Session file "${filePath}" is missing its session header record.`)

  return buildSessionStore(header, filePath, messages, cacheStats)
}
