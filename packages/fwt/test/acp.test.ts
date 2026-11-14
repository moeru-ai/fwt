import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { startAcpServer } from '../src/acp'
import { parsePermissionOutcome } from '../src/acp/protocol'

interface AcpHarness {
  close: () => Promise<void>
  notifications: JsonRpcMessage[]
  notify: (method: string, params?: Record<string, unknown>) => void
  onRequest: (handler: (msg: JsonRpcMessage) => unknown) => void
  request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

interface JsonRpcMessage {
  error?: { code: number, message: string }
  id?: null | number | string
  jsonrpc: '2.0'
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

const writeSse = (res: ServerResponse, chunks: unknown[]): void => {
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
): Promise<{ baseURL: string, close: () => Promise<void>, requests: Record<string, unknown>[] }> => {
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of req)
        chunks.push(chunk as Uint8Array)
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>
      requests.push(body)
      handler(body, requests.length - 1, res, req)
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    }),
    requests,
  }
}

const createAcpHarness = (options: {
  baseURL: string
  cwd: string
  sessionsDir: string
}): AcpHarness => {
  const clientToServer = new PassThrough()
  const serverToClient = new PassThrough()
  const notifications: JsonRpcMessage[] = []
  const pending = new Map<number | string, { reject: (e: unknown) => void, resolve: (v: Record<string, unknown>) => void }>()
  let nextId = 1
  let requestHandler: ((msg: JsonRpcMessage) => unknown) | undefined

  const rl = createInterface({ crlfDelay: Infinity, input: serverToClient })
  rl.on('line', (line) => {
    if (line.trim() === '')
      return
    const msg = JSON.parse(line) as JsonRpcMessage
    if (msg.method != null && msg.id != null) {
      void Promise.resolve(requestHandler?.(msg)).then((result) => {
        clientToServer.write(`${JSON.stringify({ id: msg.id, jsonrpc: '2.0', result })}\n`)
      })
      return
    }
    if (msg.method != null) {
      notifications.push(msg)
      return
    }
    if (msg.id != null) {
      const waiter = pending.get(msg.id)
      if (waiter == null)
        return
      pending.delete(msg.id)
      if (msg.error != null)
        waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else
        waiter.resolve(msg.result ?? {})
    }
  })

  const serverDone = startAcpServer({
    defaultCwd: options.cwd,
    input: clientToServer,
    modelConfig: {
      apiKey: 'test-key',
      baseURL: options.baseURL,
      home: options.cwd,
      model: 'mock-model',
      protocol: 'chat',
    },
    output: serverToClient,
    sessionsDir: options.sessionsDir,
  })

  const request = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { reject, resolve })
      clientToServer.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`)
    })
  }

  const notify = (method: string, params?: Record<string, unknown>): void => {
    clientToServer.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  const close = async (): Promise<void> => {
    clientToServer.end()
    await serverDone
    rl.close()
    serverToClient.end()
  }

  return {
    close,
    notifications,
    notify,
    onRequest: (handler) => {
      requestHandler = handler
    },
    request,
  }
}

describe('aCP v1 and v2 dual-version server', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()
      if (fn != null)
        await fn()
    }
  })

  it('negotiates protocolVersion 1 and emits session/update notifications during tool execution', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-acp-v1-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))

    const httpServer = await createMockChatServer((_body, idx, res) => {
      if (idx === 0) {
        writeSse(res, [
          {
            choices: [{
              delta: {
                role: 'assistant',
                tool_calls: [{
                  function: { arguments: '{"cmd":"echo acp-v1"}', name: 'exec_command' },
                  id: 'call_v1',
                  index: 0,
                  type: 'function',
                }],
              },
              finish_reason: null,
              index: 0,
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
        ])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: 'v1-complete', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ])
    })
    cleanups.push(httpServer.close)

    const acp = createAcpHarness({ baseURL: httpServer.baseURL, cwd: dir, sessionsDir: dir })
    cleanups.push(acp.close)

    const init = await acp.request('initialize', { protocolVersion: 1 })
    expect(init.protocolVersion).toBe(1)
    expect(init.agentCapabilities).toMatchObject({ loadSession: true })

    const created = await acp.request('session/new', { cwd: dir })
    const sessionId = created.sessionId as string
    expect(sessionId).toBeTypeOf('string')

    const promptRes = await acp.request('session/prompt', {
      prompt: [{ text: 'run echo', type: 'text' }],
      sessionId,
    })
    expect(promptRes.stopReason).toBe('end_turn')
    expect(promptRes.text).toBe('v1-complete')

    const methods = acp.notifications.map(n => n.method)
    expect(methods.every(m => m === 'session/update')).toBe(true)
    const updateKinds = acp.notifications.map(n => (n.params as undefined | { update?: { sessionUpdate?: string } })?.update?.sessionUpdate)
    expect(updateKinds).toContain('tool_call')
    expect(updateKinds).toContain('tool_call_update')
    expect(updateKinds).toContain('agent_message_chunk')
  })

  it('negotiates protocolVersion 2, emits state_update patches, supports ask permissions, and handles session/cancel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-acp-v2-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))

    const httpServer = await createMockChatServer((_body, idx, res) => {
      if (idx === 0) {
        writeSse(res, [
          {
            choices: [{
              delta: {
                role: 'assistant',
                tool_calls: [{
                  function: { arguments: '{"cmd":"echo denied-cmd"}', name: 'exec_command' },
                  id: 'call_deny',
                  index: 0,
                  type: 'function',
                }],
              },
              finish_reason: null,
              index: 0,
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
        ])
        return
      }
      if (idx === 1) {
        writeSse(res, [
          { choices: [{ delta: { content: 'ok-after-deny', role: 'assistant' }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
        ])
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"working"},"finish_reason":null,"index":0}]}\n\n')
    })
    cleanups.push(httpServer.close)

    const acp = createAcpHarness({ baseURL: httpServer.baseURL, cwd: dir, sessionsDir: dir })
    cleanups.push(acp.close)

    const init = await acp.request('initialize', { protocolVersion: 2 })
    expect(init.protocolVersion).toBe(2)
    expect(init.capabilities).toMatchObject({ modes: { supported: ['auto', 'ask'] } })

    const created = await acp.request('session/new', { cwd: dir })
    const sessionId = created.sessionId as string
    await acp.request('session/set_mode', { modeId: 'ask', sessionId })

    const permissionRequests: JsonRpcMessage[] = []
    acp.onRequest((msg) => {
      permissionRequests.push(msg)
      return { outcome: { optionId: 'reject_once', outcome: 'selected' } }
    })

    const promptRes = await acp.request('session/prompt', {
      prompt: 'try command',
      sessionId,
    })
    expect(promptRes.stopReason).toBe('end_turn')
    expect(promptRes.text).toBe('ok-after-deny')
    expect(permissionRequests).toHaveLength(1)
    expect(permissionRequests[0].method).toBe('session/request_permission')

    const v2Updates = acp.notifications.filter(n => n.method === 'state_update')
    expect(v2Updates.some(n => n.params?.type === 'tool_call_patch' && n.params?.isError === true)).toBe(true)

    const pendingPrompt = acp.request('session/prompt', {
      prompt: 'will cancel',
      sessionId,
    })
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 80)
      timer.unref()
    })
    acp.notify('session/cancel', { sessionId })

    const cancelledRes = await pendingPrompt
    expect(cancelledRes.stopReason).toBe('cancelled')

    const resumed = await acp.request('session/resume', { sessionId })
    expect(resumed.sessionId).toBe(sessionId)
  })
})

describe('parsePermissionOutcome', () => {
  it('accepts only the ACP request_permission response shapes', () => {
    expect(parsePermissionOutcome({ outcome: { optionId: 'allow_always', outcome: 'selected' } })).toBe('allow_always')
    expect(parsePermissionOutcome({ outcome: { outcome: 'cancelled' } })).toBe('cancelled')
    expect(parsePermissionOutcome({ outcome: { optionId: 'something_else', outcome: 'selected' } })).toBe('reject_once')
    expect(parsePermissionOutcome({ outcome: 'cancelled' })).toBe('reject_once')
  })
})
