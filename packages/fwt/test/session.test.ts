import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createCacheStats,
  createSessionStore,
  forkSessionStore,
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
    expect(JSON.parse((await readFile(store.filePath, 'utf8')).split('\n')[0])).not.toHaveProperty('version')

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
    expect(reopened.usageBaseline()).toEqual({ inputTokens: 2000, messageCount: 1 })

    const latest = await openSessionStore('latest', dir, dir)
    expect(latest.filePath).toBe(store.filePath)
  })

  it('scopes latest to the requested working directory', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'fwt-latest-'))
    const cwdA = join(sessionsDir, 'worktree-a')
    const cwdB = join(sessionsDir, 'worktree-b')
    tempDirs.push(sessionsDir)

    const olderA = await createSessionStore({ cwd: cwdA, id: 'older-a', model: 'm', protocol: 'chat', provider: 'p', sessionsDir })
    const newestB = await createSessionStore({ cwd: cwdB, id: 'newest-b', model: 'm', protocol: 'chat', provider: 'p', sessionsDir })
    const newestA = await createSessionStore({ cwd: cwdA, id: 'newest-a', model: 'm', protocol: 'chat', provider: 'p', sessionsDir })
    await utimes(olderA.filePath, 1000, 1000)
    await utimes(newestB.filePath, 2000, 2000)
    await utimes(newestA.filePath, 3000, 3000)

    expect((await openSessionStore('latest', sessionsDir, cwdA)).filePath).toBe(newestA.filePath)
    expect((await openSessionStore('latest', sessionsDir, cwdB)).header.id).toBe('newest-b')
    const missingCwd = join(sessionsDir, 'missing')
    await expect(openSessionStore('latest', sessionsDir, missingCwd)).rejects.toThrow(`No session found for working directory "${missingCwd}".`)
    expect(olderA.filePath).not.toBe(newestA.filePath)
  })

  it('forks messages into a new session without changing the source or copying usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-fork-'))
    tempDirs.push(dir)
    const source = await createSessionStore({
      cwd: dir,
      id: 'source-session',
      model: 'deepseek-chat',
      protocol: 'chat',
      provider: 'deepseek',
      sessionsDir: dir,
    })
    await source.appendMessage({ content: 'initial context', role: 'user' })
    await source.appendMessage({ content: 'answer', role: 'assistant' })
    await source.appendUsage({
      model: 'deepseek-chat',
      stepNumber: 0,
      usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100 },
    })
    const sourceBytes = await readFile(source.filePath, 'utf8')

    const fork = await forkSessionStore(source, { cwd: join(dir, 'other-worktree'), sessionsDir: dir })

    expect(fork.id).not.toBe(source.id)
    expect(fork.header).toMatchObject({
      cwd: join(dir, 'other-worktree'),
      model: source.header.model,
      protocol: source.header.protocol,
      provider: source.header.provider,
    })
    expect(fork.messages()).toEqual(source.messages())
    expect(fork.cacheStats.snapshot().steps).toBe(0)
    expect(await readFile(source.filePath, 'utf8')).toBe(sourceBytes)
    expect((await openSessionStore(fork.id, dir)).messages()).toEqual(source.messages())
  })

  it('copies compaction records in message order and ignores an incomplete final line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-compaction-fork-'))
    tempDirs.push(dir)
    const source = await createSessionStore({
      cwd: dir,
      id: 'compaction-source',
      model: 'deepseek-chat',
      protocol: 'chat',
      provider: 'deepseek',
      sessionsDir: dir,
    })
    const usage = { inputTokens: 400, outputTokens: 20, totalTokens: 420 }
    await source.appendMessage({ content: 'initial', role: 'user' })
    await source.appendMessage({ content: 'old answer', role: 'assistant' })
    await source.appendCompaction({ summary: 'work summary', tailStartMessage: 1, usage })
    await source.appendMessage({ content: 'recent', role: 'user' })

    const fork = await forkSessionStore(source, { sessionsDir: dir })
    const reopened = await openSessionStore(fork.id, dir)
    expect(reopened.messages()).toEqual(source.messages())
    expect(reopened.compaction()).toMatchObject({ summary: 'work summary', tailStartMessage: 1, usage })
    expect(reopened.records().map(record => record.type)).toEqual(['message', 'message', 'compaction', 'message'])
    expect(reopened.cacheStats.snapshot().totalInputTokens).toBe(usage.inputTokens)

    await writeFile(fork.filePath, '{"type":"message"', { flag: 'a' })
    const afterIncomplete = await openSessionStore(fork.id, dir)
    expect(afterIncomplete.messages()).toEqual(source.messages())
    expect(afterIncomplete.compaction()?.summary).toBe('work summary')

    const noFinalNewlinePath = join(dir, 'complete-without-newline.jsonl')
    await writeFile(noFinalNewlinePath, JSON.stringify({ createdAt: new Date().toISOString(), cwd: dir, id: 'complete-without-newline', model: 'm', protocol: 'chat', provider: 'p', type: 'session' }))
    expect((await openSessionStore(noFinalNewlinePath, dir)).id).toBe('complete-without-newline')
  })

  it('rejects malformed session JSONL lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-bad-session-'))
    tempDirs.push(dir)
    const badPath = join(dir, 'bad.jsonl')
    await writeFile(badPath, '{"type":"session"}\n', 'utf8')

    await expect(openSessionStore(badPath, dir)).rejects.toThrow('Invalid session record')
  })
})
