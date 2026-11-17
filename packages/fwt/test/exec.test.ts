import process from 'node:process'

import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sleep } from '@moeru/std'
import { afterEach, describe, expect, it } from 'vitest'

import { createExecManager, createHeadTailBuffer } from '../src/tools'

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

describe('createHeadTailBuffer', () => {
  it('retains full content within the byte budget', () => {
    const buffer = createHeadTailBuffer(32)
    buffer.push(Buffer.from('hello '))
    buffer.push(Buffer.from('world'))

    const snap = buffer.snapshot()
    expect(snap.omittedBytes).toBe(0)
    expect(snap.totalBytes).toBe(11)
    expect(Buffer.concat([snap.head, snap.tail]).toString('utf8')).toBe('hello world')
  })

  it('keeps head and tail while counting omitted middle bytes', () => {
    const buffer = createHeadTailBuffer(10)
    buffer.push(Buffer.from('0123456789'))
    buffer.push(Buffer.from('9876543210'))

    const snap = buffer.snapshot()
    expect(Buffer.from(snap.head).toString('utf8')).toBe('01234')
    expect(Buffer.from(snap.tail).toString('utf8')).toBe('43210')
    expect(snap.omittedBytes).toBe(10)
    expect(snap.totalBytes).toBe(20)
  })
})

describe('createExecManager', () => {
  const managers: ReturnType<typeof createExecManager>[] = []
  const tempDirs: string[] = []

  const makeManager = (cwd?: string): ReturnType<typeof createExecManager> => {
    const manager = createExecManager({ defaultCwd: cwd })
    managers.push(manager)
    return manager
  }

  afterEach(async () => {
    while (managers.length > 0)
      managers.pop()?.dispose()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir != null && dir !== '')
        await rm(dir, { force: true, recursive: true })
    }
  })

  it('captures stdout, stderr, and exit codes for one-shot commands', async () => {
    const manager = makeManager()
    const result = await manager.execCommand({
      cmd: 'printf "out\\n"; printf "err\\n" >&2; exit 7',
    })

    expect(result.sessionId).toBeUndefined()
    expect(result.exitCode).toBe(7)
    expect(result.output).toContain('out')
    expect(result.output).toContain('err')
    expect(result.text).toContain('Process exited with code 7')
  })

  it('uses non-interactive environment values for commands', async () => {
    const manager = makeManager()
    const result = await manager.execCommand({
      cmd: 'printf "%s\\n" "$NO_COLOR" "$TERM" "$COLORTERM" "$PAGER" "$GIT_PAGER" "$GH_PAGER"',
    })

    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('1\ndumb\n\ncat\ncat\ncat\n')
  })

  it('writes stdin and closes EOF immediately when stdin is provided', async () => {
    const manager = makeManager()
    const result = await manager.execCommand({
      cmd: 'cat',
      stdin: 'alpha\nbeta\n',
      yieldTimeMs: 250,
    })

    expect(result.sessionId).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe('alpha\nbeta\n')
  })

  it('supports interactive write_stdin when stdin is omitted', async () => {
    const manager = makeManager()
    const first = await manager.execCommand({
      cmd: 'while IFS= read -r line; do echo "got:$line"; [ "$line" = "quit" ] && break; done',
      yieldTimeMs: 250,
    })

    expect(first.sessionId).toBeTypeOf('number')
    expect(manager.activeSessionCount()).toBe(1)

    const second = await manager.writeStdin({
      chars: 'ping\n',
      sessionId: first.sessionId!,
      yieldTimeMs: 250,
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.output).toContain('got:ping')

    const third = await manager.writeStdin({
      chars: 'quit\n',
      sessionId: first.sessionId!,
      yieldTimeMs: 500,
    })
    expect(third.sessionId).toBeUndefined()
    expect(third.exitCode).toBe(0)
    expect(third.output).toContain('got:quit')
    expect(manager.activeSessionCount()).toBe(0)
  })

  it('retains exit output until drained by write_stdin after a process closes in background', async () => {
    const manager = makeManager()
    const first = await manager.execCommand({
      cmd: 'sleep 0.35; echo finished',
      yieldTimeMs: 250,
    })

    expect(first.sessionId).toBeTypeOf('number')
    await sleep(250)

    const polled = await manager.writeStdin({
      sessionId: first.sessionId!,
      yieldTimeMs: 250,
    })
    expect(polled.exitCode).toBe(0)
    expect(polled.output).toContain('finished')

    await expect(manager.writeStdin({ sessionId: first.sessionId! })).rejects.toThrow('Unknown process session ID')
  })

  it('truncates oversized output with an omission marker without breaking UTF-8', async () => {
    const manager = makeManager()
    const result = await manager.execCommand({
      cmd: 'node -e "process.stdout.write(\'你\'.repeat(1000))"',
      maxOutputTokens: 20,
    })

    expect(result.omittedBytes).toBeGreaterThan(0)
    expect(result.output).toContain('bytes omitted')
    expect(result.output).not.toContain('\uFFFD')
  })

  it('reaps the spawned process group on AbortSignal cancellation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-exec-'))
    tempDirs.push(dir)
    const pidFile = join(dir, 'child.pid')

    const manager = makeManager(dir)
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(new Error('cancelled')), 150)

    try {
      await expect(manager.execCommand({
        cmd: `sleep 30 & echo $! > "${pidFile}"; wait`,
        yieldTimeMs: 5000,
      }, controller.signal)).rejects.toThrow('cancelled')
    }
    finally {
      clearTimeout(abortTimer)
    }

    const childPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10)
    expect(Number.isInteger(childPid)).toBe(true)
    await sleep(50)
    expect(isPidAlive(childPid)).toBe(false)
    expect(manager.activeSessionCount()).toBe(0)
  })
})
