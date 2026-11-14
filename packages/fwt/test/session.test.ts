import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createCacheStats,
  createSessionStore,
  openSessionStore,
} from '../src/session'

describe('createCacheStats', () => {
  it('ignores drops within the 1024-token noise floor and flags larger misses', () => {
    const stats = createCacheStats()

    expect(stats.record({ inputTokens: 1500, outputTokens: 50, totalTokens: 1550 }, 0)).toBeUndefined()
    expect(stats.record({ cacheReadInputTokens: 600, inputTokens: 1800, outputTokens: 50, totalTokens: 1850 }, 1)).toBeUndefined()

    const miss = stats.record({ cacheReadInputTokens: 100, inputTokens: 2000, outputTokens: 50, totalTokens: 2050 }, 2)
    expect(miss).toEqual({
      actualCacheReadTokens: 100,
      expectedCachedTokens: 1800,
      missedTokens: 1700,
      stepNumber: 2,
    })

    const snap = stats.snapshot()
    expect(snap.steps).toBe(3)
    expect(snap.misses).toHaveLength(1)
    expect(snap.totalCacheReadTokens).toBe(700)
    expect(snap.totalInputTokens).toBe(5300)
  })
})

describe('sessionStore JSONL persistence', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir != null && dir !== '')
        await rm(dir, { force: true, recursive: true })
    }
  })

  it('persists canonical messages and restores CacheStats on resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-session-'))
    tempDirs.push(dir)

    const store = await createSessionStore({
      cwd: dir,
      id: 'session-alpha',
      model: 'deepseek-chat',
      protocol: 'chat',
      provider: 'deepseek',
      sessionsDir: dir,
    })

    await store.appendMessage({ content: 'hello', role: 'user' })
    await store.appendMessage({
      content: [
        { content: [{ text: 'thinking', type: 'text' }], type: 'reasoning' },
        { text: 'hi there', type: 'text' },
      ],
      role: 'assistant',
    })
    store.cacheStats.record({ inputTokens: 2000, outputTokens: 100, totalTokens: 2100 }, 0)
    await store.appendUsage({
      model: 'deepseek-chat',
      stepNumber: 0,
      usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 },
    })
    await store.flush()

    const reopened = await openSessionStore('session-alpha', dir)
    expect(reopened.id).toBe('session-alpha')
    expect(reopened.messages()).toEqual(store.messages())
    expect(reopened.cacheStats.snapshot().lastInputTokens).toBe(2000)

    const latest = await openSessionStore('latest', dir)
    expect(latest.filePath).toBe(store.filePath)
  })

  it('rejects malformed session JSONL lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-bad-session-'))
    tempDirs.push(dir)
    const badPath = join(dir, 'bad.jsonl')
    await writeFile(badPath, '{"type":"session"}\n', 'utf8')

    await expect(openSessionStore(badPath, dir)).rejects.toThrow('Invalid session record')
  })
})
