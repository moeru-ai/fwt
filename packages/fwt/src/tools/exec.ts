import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { sleepWithAbort } from '@moeru/std'

const MIN_YIELD_TIME_MS = 250
const DEFAULT_EXEC_YIELD_TIME_MS = 10_000
const DEFAULT_WRITE_YIELD_TIME_MS = 250
const DEFAULT_EMPTY_YIELD_TIME_MS = 5_000
const MAX_YIELD_TIME_MS = 30_000
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000
const BYTES_PER_TOKEN = 4
const MAX_CAPTURE_BYTES = 1024 * 1024
const MAX_SESSIONS = 64
const POST_EXIT_DRAIN_MS = 100

export interface ExecManager {
  activeSessionCount: () => number
  dispose: () => void
  execCommand: (input: ExecCommandInput, signal?: AbortSignal) => Promise<ExecOutput>
  writeStdin: (input: WriteStdinInput, signal?: AbortSignal) => Promise<ExecOutput>
}

interface ExecCommandInput {
  cmd: string
  maxOutputTokens?: number
  stdin?: string
  workdir?: string
  yieldTimeMs?: number
}

interface ExecManagerOptions {
  defaultCwd?: string
  shell?: string
}

interface ExecOutput {
  exitCode?: null | number
  exitSignal?: NodeJS.Signals | null
  omittedBytes: number
  output: string
  sessionId?: number
  text: string
  totalBytes: number
  wallTimeMs: number
}

interface ExecSession {
  buffer: HeadTailBuffer
  child: ChildProcessWithoutNullStreams
  closed: boolean
  closePromise: Promise<void>
  exitCode: null | number
  exitSignal: NodeJS.Signals | null
  id: number
  spawnError?: Error
}

interface HeadTailBuffer {
  push: (chunk: Uint8Array) => void
  snapshot: () => HeadTailSnapshot
}

interface HeadTailSnapshot {
  head: Uint8Array
  omittedBytes: number
  retainedBytes: number
  tail: Uint8Array
  totalBytes: number
}

interface WriteStdinInput {
  chars?: string
  maxOutputTokens?: number
  sessionId: number
  yieldTimeMs?: number
}

const utf8CharLength = (leadByte: number): number => {
  if ((leadByte & 0x80) === 0)
    return 1
  if ((leadByte & 0xE0) === 0xC0)
    return 2
  if ((leadByte & 0xF0) === 0xE0)
    return 3
  if ((leadByte & 0xF8) === 0xF0)
    return 4
  return 1
}

const sliceUtf8Head = (bytes: Uint8Array, limit: number): Uint8Array => {
  const end = Math.min(bytes.length, limit)
  if (end === 0)
    return bytes.subarray(0, 0)

  let pos = end - 1
  const minPos = Math.max(0, end - 4)
  while (pos > minPos && (bytes[pos] & 0xC0) === 0x80)
    pos -= 1

  if ((bytes[pos] & 0xC0) === 0x80)
    return bytes.subarray(0, pos)

  const expectedLen = utf8CharLength(bytes[pos])
  if (pos + expectedLen > end)
    return bytes.subarray(0, pos)

  return bytes.subarray(0, end)
}

const sliceUtf8Tail = (bytes: Uint8Array, limit: number): Uint8Array => {
  let start = Math.max(0, bytes.length - limit)
  while (start < bytes.length && (bytes[start] & 0xC0) === 0x80)
    start += 1
  return bytes.subarray(start)
}

export const createHeadTailBuffer = (maxBytes: number): HeadTailBuffer => {
  const budget = Math.max(0, Math.trunc(maxBytes))
  const headBudget = Math.floor(budget / 2)
  const tailBudget = budget - headBudget
  const headChunks: Uint8Array[] = []
  let headBytes = 0
  let tailChunks: Uint8Array[] = []
  let tailBytes = 0
  let omittedBytes = 0

  const push = (chunk: Uint8Array): void => {
    if (chunk.length === 0)
      return

    let rest = chunk
    if (headBytes < headBudget) {
      const take = Math.min(chunk.length, headBudget - headBytes)
      headChunks.push(chunk.subarray(0, take))
      headBytes += take
      rest = chunk.subarray(take)
    }

    if (rest.length === 0)
      return

    if (tailBudget === 0) {
      omittedBytes += rest.length
      return
    }

    if (rest.length >= tailBudget) {
      omittedBytes += tailBytes + (rest.length - tailBudget)
      tailChunks = [rest.subarray(rest.length - tailBudget)]
      tailBytes = tailBudget
      return
    }

    tailChunks.push(rest)
    tailBytes += rest.length

    while (tailBytes > tailBudget) {
      const overflow = tailBytes - tailBudget
      const first = tailChunks[0]
      if (first.length <= overflow) {
        tailChunks.shift()
        tailBytes -= first.length
        omittedBytes += first.length
      }
      else {
        tailChunks[0] = first.subarray(overflow)
        tailBytes -= overflow
        omittedBytes += overflow
      }
    }
  }

  const snapshot = (): HeadTailSnapshot => {
    const head = Buffer.concat(headChunks)
    const tail = Buffer.concat(tailChunks)
    const retainedBytes = head.length + tail.length
    return {
      head,
      omittedBytes,
      retainedBytes,
      tail,
      totalBytes: retainedBytes + omittedBytes,
    }
  }

  return { push, snapshot }
}

const formatSnapshot = (
  snapshot: HeadTailSnapshot,
  maxBytes: number,
): { omittedBytes: number, output: string, totalBytes: number } => {
  const { totalBytes } = snapshot
  const fits = snapshot.retainedBytes <= maxBytes
  if (snapshot.omittedBytes === 0 && fits)
    return { omittedBytes: 0, output: Buffer.concat([snapshot.head, snapshot.tail]).toString('utf8'), totalBytes }

  const [fullHead, fullTail] = snapshot.omittedBytes === 0
    ? [Buffer.concat([snapshot.head, snapshot.tail]), Buffer.concat([snapshot.head, snapshot.tail])]
    : [snapshot.head, snapshot.tail]
  const headBudget = Math.floor(maxBytes / 2)
  const head = fits ? fullHead : sliceUtf8Head(fullHead, headBudget)
  const tail = fits ? fullTail : sliceUtf8Tail(fullTail, maxBytes - headBudget)
  const omittedBytes = totalBytes - head.length - tail.length
  return {
    omittedBytes,
    output: `${Buffer.from(head).toString('utf8')}\n...${omittedBytes} bytes omitted...\n${Buffer.from(tail).toString('utf8')}`,
    totalBytes,
  }
}

const clampYieldTime = (ms: number): number =>
  Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, Math.trunc(ms)))

const resolveMaxBytes = (maxOutputTokens: number | undefined): number =>
  Math.max(1, Math.trunc(maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)) * BYTES_PER_TOKEN

const killProcessGroup = (pid: number | undefined, signal: NodeJS.Signals): void => {
  if (pid == null)
    return
  try {
    process.kill(-pid, signal)
  }
  catch {
    try {
      process.kill(pid, signal)
    }
    catch {}
  }
}

const waitForCloseOrYield = async (
  closePromise: Promise<void>,
  yieldTimeMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  signal?.throwIfAborted()
  const timerController = new AbortController()
  const combinedSignal = signal
    ? AbortSignal.any([signal, timerController.signal])
    : timerController.signal

  try {
    await Promise.race([
      closePromise,
      sleepWithAbort(yieldTimeMs, combinedSignal),
    ])
  }
  catch (error) {
    if (signal?.aborted)
      throw signal.reason instanceof Error ? signal.reason : error
  }
  finally {
    timerController.abort()
  }
}

const formatExecOutput = (
  session: ExecSession,
  wallTimeMs: number,
  maxBytes: number,
): ExecOutput => {
  const snapshot = session.buffer.snapshot()
  session.buffer = createHeadTailBuffer(MAX_CAPTURE_BYTES)
  const { omittedBytes, output, totalBytes } = formatSnapshot(snapshot, maxBytes)

  const lines = [
    `Wall time: ${(wallTimeMs / 1000).toFixed(3)} seconds`,
    session.closed
      ? session.exitSignal != null
        ? `Process terminated by signal ${session.exitSignal}`
        : `Process exited with code ${session.exitCode ?? 0}`
      : `Process running with session ID ${session.id}`,
  ]

  if (totalBytes > 0) {
    lines.push('Output:')
    lines.push(output)
  }

  return {
    ...(session.closed
      ? { exitCode: session.exitCode, exitSignal: session.exitSignal }
      : { sessionId: session.id }),
    omittedBytes,
    output,
    text: lines.join('\n'),
    totalBytes,
    wallTimeMs,
  }
}

export const createExecManager = (options: ExecManagerOptions = {}): ExecManager => {
  const defaultCwd = options.defaultCwd ?? process.cwd()
  const shell = options.shell ?? (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh')
  const sessions = new Map<number, ExecSession>()
  let nextId = 1

  const activeSessionCount = (): number => {
    let count = 0
    for (const session of sessions.values()) {
      if (!session.closed)
        count += 1
    }
    return count
  }

  const settle = async (
    session: ExecSession,
    startedAt: number,
    yieldMs: number,
    maxOutputTokens: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ExecOutput> => {
    try {
      await waitForCloseOrYield(session.closePromise, yieldMs, signal)
    }
    catch (error) {
      killProcessGroup(session.child.pid, 'SIGKILL')
      sessions.delete(session.id)
      throw error
    }
    if (session.closed)
      sessions.delete(session.id)
    return formatExecOutput(session, Date.now() - startedAt, resolveMaxBytes(maxOutputTokens))
  }

  const execCommand = async (input: ExecCommandInput, signal?: AbortSignal): Promise<ExecOutput> => {
    signal?.throwIfAborted()

    if (activeSessionCount() >= MAX_SESSIONS)
      throw new Error(`Maximum active terminal sessions (${MAX_SESSIONS}) reached.`)

    const cwd = input.workdir != null && input.workdir !== '' ? resolve(defaultCwd, input.workdir) : defaultCwd
    const startedAt = Date.now()
    const id = nextId++

    const child = spawn(shell, ['-c', input.cmd], {
      cwd,
      detached: true,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const { promise: closePromise, resolve: resolveClose } = Promise.withResolvers<void>()

    const session: ExecSession = {
      buffer: createHeadTailBuffer(MAX_CAPTURE_BYTES),
      child,
      closed: false,
      closePromise,
      exitCode: null,
      exitSignal: null,
      id,
    }
    sessions.set(id, session)

    let postExitTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (postExitTimer != null) {
        clearTimeout(postExitTimer)
        postExitTimer = undefined
      }
      session.closed = true
      resolveClose()
    }

    child.stdin.on('error', () => {})
    if (input.stdin !== undefined)
      child.stdin.end(input.stdin)

    child.stdout.on('data', (chunk: Uint8Array) => {
      session.buffer.push(chunk)
    })
    child.stderr.on('data', (chunk: Uint8Array) => {
      session.buffer.push(chunk)
    })

    child.on('error', (error) => {
      session.spawnError = error
      finish()
    })

    child.on('exit', (code, exitSig) => {
      session.exitCode = code
      session.exitSignal = exitSig
      if (!session.closed) {
        postExitTimer = setTimeout(finish, POST_EXIT_DRAIN_MS)
        postExitTimer.unref()
      }
    })

    child.on('close', (code, exitSig) => {
      if (session.exitCode === null && code !== null)
        session.exitCode = code
      if (session.exitSignal === null && exitSig !== null)
        session.exitSignal = exitSig
      finish()
    })

    const result = await settle(session, startedAt, clampYieldTime(input.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS), input.maxOutputTokens, signal)
    if (session.spawnError)
      throw new Error(`Failed to execute command in "${cwd}": ${session.spawnError.message}`, { cause: session.spawnError })
    return result
  }

  const writeStdin = async (input: WriteStdinInput, signal?: AbortSignal): Promise<ExecOutput> => {
    signal?.throwIfAborted()

    const session = sessions.get(input.sessionId)
    if (!session)
      throw new Error(`Unknown process session ID: ${input.sessionId}`)

    const startedAt = Date.now()
    const chars = input.chars ?? ''

    if (chars.length > 0 && !session.closed && !session.child.stdin.destroyed && session.child.stdin.writable)
      session.child.stdin.write(chars)

    const defaultYield = chars.length > 0 ? DEFAULT_WRITE_YIELD_TIME_MS : DEFAULT_EMPTY_YIELD_TIME_MS
    return settle(session, startedAt, clampYieldTime(input.yieldTimeMs ?? defaultYield), input.maxOutputTokens, signal)
  }

  const dispose = (): void => {
    for (const session of sessions.values())
      killProcessGroup(session.child.pid, 'SIGKILL')
    sessions.clear()
  }

  return {
    activeSessionCount,
    dispose,
    execCommand,
    writeStdin,
  }
}
