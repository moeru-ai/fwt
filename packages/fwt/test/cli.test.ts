import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import { createMemoryIo } from '@moeru/cliff/testing'
import { afterEach, describe, expect, it } from 'vitest'

import { version as packageVersion } from '../package.json' with { type: 'json' }
import { createFwtCli } from '../src/cli'

const writeChatSse = (res: ServerResponse, chunks: unknown[]): void => {
  res.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  for (const chunk of chunks)
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

const createMockChatServer = async (
  handler: (body: Record<string, unknown>, index: number, res: ServerResponse, req: IncomingMessage) => void,
): Promise<{ baseURL: string, close: () => Promise<void>, headers: IncomingMessage['headers'][], requests: Record<string, unknown>[] }> => {
  const requests: Record<string, unknown>[] = []
  const headers: IncomingMessage['headers'][] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of req)
        chunks.push(chunk as Uint8Array)
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
      requests.push(body)
      headers.push(req.headers)
      handler(body, requests.length - 1, res, req)
    })()
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()))
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => new Promise<void>((resolveClose, rejectClose) => {
      server.close(err => err ? rejectClose(err) : resolveClose())
    }),
    headers,
    requests,
  }
}

describe('fwt CLI', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()
      if (fn != null)
        await fn()
    }
  })

  it('runs headless -p, jsonl output, and --resume against a local mock endpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-cli-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))

    const server = await createMockChatServer((_body, idx, res) => {
      if (idx === 0) {
        writeChatSse(res, [
          { choices: [{ delta: { content: 'first-answer', role: 'assistant' }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
        ])
        return
      }
      writeChatSse(res, [
        { choices: [{ delta: { content: 'second-answer', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ])
    })
    cleanups.push(server.close)

    const cli = createFwtCli({
      home: dir,
    })

    const io1 = createMemoryIo({ cwd: dir })
    const code1 = await cli.execute([
      '-p',
      'hello one',
      '--base-url',
      server.baseURL,
      '--api-key',
      'test-key',
      '--model',
      'mock-model',
      '--output',
      'jsonl',
    ], io1)
    expect(code1).toBe(0)

    const lines = io1.stdout.text().trim().split('\n').map(line => JSON.parse(line) as { sessionId?: string, text?: string, type: string })
    const resultLine = lines.find(line => line.type === 'result')
    expect(resultLine?.text).toBe('first-answer')
    expect(resultLine?.sessionId).toBeTypeOf('string')

    const io2 = createMemoryIo({ cwd: dir })
    const code2 = await cli.execute([
      '-p',
      'hello two',
      '--resume',
      resultLine!.sessionId!,
      '--base-url',
      server.baseURL,
      '--api-key',
      'test-key',
      '--model',
      'mock-model',
    ], io2)
    expect(code2).toBe(0)
    expect(io2.stdout.text()).toBe('second-answer\n')
    expect(JSON.stringify(server.requests[1].messages)).toContain('first-answer')
  })

  it('adds piped stdin to a prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-cli-stdin-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))

    const server = await createMockChatServer((_body, _idx, res) => {
      writeChatSse(res, [
        { choices: [{ delta: { content: 'reviewed', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ])
    })
    cleanups.push(server.close)
    const cli = createFwtCli({ home: dir })
    const args = ['--base-url', server.baseURL, '--api-key', 'test-key', '--model', 'mock-model']
    const pipedStdin = new PassThrough()
    pipedStdin.end('diff --git a/file b/file\n+change')
    expect(await cli.execute(['-p', 'Review this diff', ...args], createMemoryIo({ cwd: dir, stdin: pipedStdin }))).toBe(0)
    const userMessage = (server.requests[0].messages as { content: string, role: string }[]).find(message => message.role === 'user')
    expect(userMessage?.content).toContain('Review this diff\n\n<stdin>\ndiff --git a/file b/file\n+change\n</stdin>')

    const emptyStdin = new PassThrough()
    emptyStdin.end()
    expect(await cli.execute(['-p', 'No input is expected', ...args], createMemoryIo({ cwd: dir, stdin: emptyStdin }))).toBe(0)
    expect(JSON.stringify(server.requests[1].messages)).toContain('No input is expected')
    expect(JSON.stringify(server.requests[1].messages)).not.toContain('<stdin>')
  })

  it('sends --image data to an image-capable model and rejects unsupported models', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-cli-image-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))
    const runDir = join(dir, 'workspace')
    await mkdir(runDir)
    const imagePath = join(runDir, 'screen.png')
    const imageBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    await writeFile(imagePath, imageBytes)

    const server = await createMockChatServer((_body, _idx, res) => {
      writeChatSse(res, [
        {
          choices: [{
            delta: { content: 'seen', role: 'assistant' },
            finish_reason: null,
            index: 0,
          }],
        },
        {
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
        },
      ])
    })
    cleanups.push(server.close)
    const cli = createFwtCli({ home: dir })
    expect(await cli.execute([
      '-p',
      'Describe this image',
      '-i',
      'screen.png',
      '-i',
      'screen.png',
      '--cwd',
      runDir,
      '--base-url',
      server.baseURL,
      '--api-key',
      'test-key',
      '--model',
      'mock-model',
    ], createMemoryIo({ cwd: dir }))).toBe(0)
    const imageRequest = JSON.stringify(server.requests[0].messages)
    const imageData = `data:image/png;base64,${imageBytes.toString('base64')}`
    expect(imageRequest.split(imageData)).toHaveLength(3)

    await writeFile(join(dir, 'config.toml'), `[providers.local]\nmodel = "mock-model"\n[providers.local.base_url]\nchat = "${server.baseURL}"\n[providers.local.models.mock-model]\nimage = false\n`)
    const rejectedIo = createMemoryIo({ cwd: dir })
    expect(await cli.execute(['-p', 'Describe this image', '-i', imagePath, '--provider', 'local'], rejectedIo)).not.toBe(0)
    expect(rejectedIo.stderr.text()).toContain('does not accept image input')
    expect(server.requests).toHaveLength(1)
  })

  it('forks a session into a new worktree with the same request prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-cli-fork-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))
    const otherCwd = join(dir, 'other-worktree')
    const server = await createMockChatServer((_body, index, res) => {
      writeChatSse(res, [
        { choices: [{ delta: { content: `answer-${index}`, role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ])
    })
    cleanups.push(server.close)
    const cli = createFwtCli({ home: dir })
    const incompatibleIo = createMemoryIo({ cwd: dir })
    expect(await cli.execute(['-p', 'prompt', '--resume', 'source', '--fork', 'source'], incompatibleIo)).not.toBe(0)
    expect(incompatibleIo.stderr.text()).toContain('--resume and --fork cannot be used together.')
    const run = async (args: string[]): Promise<{ sessionId: string }> => {
      const io = createMemoryIo({ cwd: dir })
      expect(await cli.execute(args, io)).toBe(0)
      const result = io.stdout.text().trim().split('\n').map(line => JSON.parse(line) as { sessionId?: string, type: string }).find(line => line.type === 'result')
      return { sessionId: result!.sessionId! }
    }
    const common = ['--base-url', server.baseURL, '--api-key', 'test-key', '--model', 'mock-model', '--header', 'x-session: {session}']

    const source = await run(['-p', 'first prompt', ...common, '--output', 'jsonl'])
    await run(['-p', 'source follow-up', '--resume', source.sessionId, ...common, '--output', 'jsonl'])
    const fork = await run(['-p', 'fork follow-up', '--fork', source.sessionId, '--cwd', otherCwd, ...common, '--output', 'jsonl'])

    const sourceLastRequest = server.requests[1].messages as unknown[]
    const forkRequest = server.requests[2].messages as unknown[]
    expect(JSON.stringify(forkRequest.slice(0, sourceLastRequest.length)))
      .toBe(JSON.stringify(sourceLastRequest))
    expect(JSON.stringify(forkRequest.at(-1))).toContain(`cwd: ${otherCwd}`)
    expect(JSON.stringify(forkRequest.at(-1))).toContain(`forked from a session in ${dir}`)
    expect(fork.sessionId).not.toBe(source.sessionId)
    expect(server.headers[0]['x-session']).toBe(source.sessionId)
    expect(server.headers[2]['x-session']).toBe(fork.sessionId)
  })

  it('spawns the compiled bin.js binary cleanly for --help, acp subcommand, and --acp handshakes', async () => {
    const binDist = resolve(import.meta.dirname, '..', 'dist', 'bin.js')

    const helpOutput = await new Promise<string>((resolveOut, rejectOut) => {
      const child = spawn(process.execPath, [binDist, '--help'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      child.stdout.on('data', chunk => chunks.push(chunk as Buffer))
      child.on('error', rejectOut)
      child.on('close', (code) => {
        if (code === 0)
          resolveOut(Buffer.concat(chunks).toString('utf8'))
        else
          rejectOut(new Error(`Help exited with code ${code}`))
      })
    })
    expect(helpOutput).toContain('fwt')
    expect(helpOutput).toContain('acp')

    const versionOutput = await new Promise<string>((resolveVer, rejectVer) => {
      const child = spawn(process.execPath, [binDist, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      child.stdout.on('data', chunk => chunks.push(chunk as Buffer))
      child.on('error', rejectVer)
      child.on('close', (code) => {
        if (code === 0)
          resolveVer(Buffer.concat(chunks).toString('utf8'))
        else
          rejectVer(new Error(`Version exited with code ${code}`))
      })
    })
    expect(versionOutput).toContain(packageVersion)

    for (const args of [['acp'], ['--acp']]) {
      const acpResponse = await new Promise<string>((resolveAcp, rejectAcp) => {
        const child = spawn(process.execPath, [binDist, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
        const chunks: Buffer[] = []
        child.stdout.on('data', chunk => chunks.push(chunk as Buffer))
        child.on('error', rejectAcp)
        child.on('close', (code) => {
          if (code === 0)
            resolveAcp(Buffer.concat(chunks).toString('utf8'))
          else
            rejectAcp(new Error(`ACP exited with code ${code}`))
        })
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"info":{"name":"test","version":"0"},"protocolVersion":2}}\n')
        child.stdin.end()
      })

      const parsed = JSON.parse(acpResponse.trim()) as { id: number, result: { protocolVersion: number } }
      expect(parsed.id).toBe(1)
      expect(parsed.result.protocolVersion).toBe(2)
    }
  })

  it('adds a provider and reuses it on headless runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-cli-provider-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))

    const server = await createMockChatServer((_body, _idx, res, req) => {
      if (req.url?.endsWith('/models') === true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'local-model' }] }))
        return
      }
      writeChatSse(res, [
        { choices: [{ delta: { content: 'from-saved-provider', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ])
    })
    cleanups.push(server.close)

    const cli = createFwtCli({ home: dir })

    const addIo = createMemoryIo({ cwd: dir })
    const addCode = await cli.execute([
      'provider',
      'add',
      'local',
      '--base-url',
      server.baseURL,
      '--protocol',
      'chat',
      '--api-key',
      'saved-secret',
      '--model',
      'local-model',
      '--default',
      'yes',
    ], addIo)
    expect(addCode).toBe(0)
    expect(addIo.stdout.text()).toBe('Added local (local) with model local-model as the default provider.\n')

    const listIo = createMemoryIo({ cwd: dir })
    expect(await cli.execute(['provider', 'ls'], listIo)).toBe(0)
    expect(listIo.stdout.text()).toBe('* local  chat  saved key  model: local-model\n')

    const runIo = createMemoryIo({ cwd: dir })
    const runCode = await cli.execute([
      '-p',
      'hello saved',
      '--effort=max',
      '--header',
      'x-a: 1',
      '--header',
      'x-session: {session}',
    ], runIo)
    expect(runCode).toBe(0)
    expect(runIo.stdout.text()).toBe('from-saved-provider\n')
    expect(server.requests.at(-1)).toMatchObject({ model: 'local-model', reasoning_effort: 'max' })
    expect(server.headers.at(-1)).toMatchObject({ 'authorization': 'Bearer saved-secret', 'x-a': '1' })
    expect(server.headers.at(-1)?.['x-session']).toMatch(/^[\w-]{8,}$/)

    const badIo = createMemoryIo({ cwd: dir })
    expect(await cli.execute(['-p', 'x', '--header', 'no-colon'], badIo)).not.toBe(0)
    expect(badIo.stderr.text()).toContain('Expected --header "name: value".')
  })

  it('exits with a code for each stop reason other than completion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-cli-exit-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))
    const server = await createMockChatServer((_body, index, res) => {
      writeChatSse(res, [
        {
          choices: [{
            delta: {
              role: 'assistant',
              tool_calls: [{ function: { arguments: `{"cmd":"echo ${index}"}`, name: 'exec_command' }, id: `call_${index}`, index: 0, type: 'function' }],
            },
            finish_reason: null,
            index: 0,
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
      ])
    })
    cleanups.push(server.close)

    const cli = createFwtCli({ home: dir })
    const io = createMemoryIo({ cwd: dir })
    expect(await cli.execute(['-p', 'loop', '--base-url', server.baseURL, '--model', 'm', '--max-turns', '1'], io)).toBe(5)
    expect(await cli.execute(['--help'], createMemoryIo())).toBe(0)
  })
})
