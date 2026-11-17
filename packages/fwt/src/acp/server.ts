import type { Message, PreToolCall, ToolCallPart, ToolResultPart } from '@xsai/text'

import type { AgentStopReason } from '../agent'
import type { ModelConfigInput, ResolvedModelConfig } from '../providers'
import type { SessionStore } from '../session'
import type { AcpProtocolVersion, PermissionMode, PermissionOutcome } from './protocol'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

import * as v from 'valibot'

import { version } from '../../package.json' with { type: 'json' }
import { buildActiveMessages, runAgent } from '../agent'
import { resolveModel, resolveRecordedModel } from '../providers'
import { createSessionStore, listSessionHeaders, openSessionStore } from '../session'
import {
  createAgentEventMapper,
  formatModeConfigOption,
  formatModes,
  initializeParamsSchema,
  jsonRpcEnvelopeSchema,
  mapStopReason,
  negotiateProtocolVersion,
  parseParams,
  parsePermissionOutcome,
  parsePromptBlocks,
  RpcError,
  sessionCancelParamsSchema,
  sessionCloseParamsSchema,
  sessionListParamsSchema,
  sessionLoadParamsSchema,
  sessionNewParamsSchema,
  sessionPromptParamsSchema,
  sessionResumeParamsSchema,
  sessionSetConfigOptionParamsSchema,
  sessionSetModeParamsSchema,
  sessionUpdate,
  toolCallFields,
  toolCallUpdate,
  toolResultUpdate,
} from './protocol'

interface AcpRuntime {
  defaultPermissionMode: PermissionMode
  maxTurns?: number
  modelConfig?: ModelConfigInput
  pendingClientRequests: Map<JsonRpcId, PendingRequest>
  protocolVersion: AcpProtocolVersion
  sendMessage: (payload: Record<string, unknown>) => void
  sendNotification: (method: string, params: Record<string, unknown>) => void
  sendRequestToClient: (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
    signal?: AbortSignal,
  ) => Promise<unknown>
  sendSessionState: (
    sessionId: string,
    state: 'idle' | 'requires_action' | 'running',
    stopReason?: string,
    error?: { code: number, message: string },
  ) => void
  sessions: Map<string, AcpSessionState>
  sessionsDir: string
  signal?: AbortSignal
}

interface AcpServerOptions {
  input?: NodeJS.ReadableStream
  maxTurns?: number
  modelConfig?: ModelConfigInput
  output?: { write: (chunk: string) => unknown }
  permissionMode?: PermissionMode
  sessionsDir: string
  signal?: AbortSignal
}

interface AcpSessionState {
  activeController?: AbortController
  model: ResolvedModelConfig
  permissionMode: PermissionMode
  store: SessionStore
  toolPolicy: Map<string, 'allow' | 'reject'>
  turn?: Promise<void>
}

type JsonRpcId = number | string

interface PendingRequest {
  reject: (reason: unknown) => void
  resolve: (value: unknown) => void
  sessionId?: string
}

const buildPreToolCall = (
  runtime: AcpRuntime,
  session: AcpSessionState,
  signal: AbortSignal,
): PreToolCall =>
  async (call: ToolCallPart): Promise<ToolResultPart | undefined> => {
    const policy = session.toolPolicy.get(call.name)
    if (session.permissionMode === 'auto' || policy === 'allow')
      return undefined

    if (policy === 'reject') {
      return {
        callId: call.callId,
        isError: true,
        output: `Tool "${call.name}" rejected by user policy.`,
        type: 'tool-result',
      }
    }

    const toolCall = toolCallFields(call, runtime.protocolVersion)
    const v2 = runtime.protocolVersion === 2
    if (v2)
      runtime.sendSessionState(session.store.id, 'requires_action')

    let outcome: PermissionOutcome
    try {
      const response = await runtime.sendRequestToClient(
        'session/request_permission',
        {
          options: [
            { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
            { kind: 'allow_always', name: 'Always allow', optionId: 'allow_always' },
            { kind: 'reject_once', name: 'Reject', optionId: 'reject_once' },
            { kind: 'reject_always', name: 'Always reject', optionId: 'reject_always' },
          ],
          sessionId: session.store.id,
          ...v2
            ? { subject: { toolCall, type: 'tool_call' }, title: `Run ${call.name}` }
            : { toolCall },
        },
        session.store.id,
        signal,
      )
      outcome = parsePermissionOutcome(response)
    }
    catch {
      signal.throwIfAborted()
      if (v2)
        runtime.sendSessionState(session.store.id, 'running')
      return {
        callId: call.callId,
        isError: true,
        output: `Tool "${call.name}" permission request cancelled.`,
        type: 'tool-result',
      }
    }

    if (v2 && outcome !== 'cancelled')
      runtime.sendSessionState(session.store.id, 'running')

    if (outcome === 'allow_always') {
      session.toolPolicy.set(call.name, 'allow')
      return undefined
    }
    if (outcome === 'allow_once')
      return undefined
    if (outcome === 'reject_always')
      session.toolPolicy.set(call.name, 'reject')
    if (outcome === 'cancelled') {
      session.activeController?.abort(new Error('Permission request cancelled'))
      signal.throwIfAborted()
    }

    return {
      callId: call.callId,
      isError: true,
      output: `Permission denied for "${call.name}".`,
      type: 'tool-result',
    }
  }

const handleInitialize = (runtime: AcpRuntime, params: unknown): Record<string, unknown> => {
  const parsed = parseParams(initializeParamsSchema, params)
  runtime.protocolVersion = negotiateProtocolVersion(parsed.protocolVersion)
  if (runtime.protocolVersion === 2 && parsed.info == null)
    throw new RpcError(-32602, 'Invalid params at info: Expected the client implementation info')

  if (runtime.protocolVersion === 1) {
    return {
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { resume: {} },
      },
      agentInfo: { name: 'fwt', version },
      authMethods: [],
      protocolVersion: 1,
    }
  }

  return {
    authMethods: [],
    capabilities: { session: { prompt: { embeddedContext: {}, image: {} } } },
    info: { name: 'fwt', version },
    protocolVersion: 2,
  }
}

const handleSessionNew = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionNewParamsSchema, params)
  const model = resolveModel(runtime.modelConfig)
  const mode = runtime.defaultPermissionMode

  const store = await createSessionStore({
    cwd: parsed.cwd,
    model: model.model,
    protocol: model.protocol,
    provider: model.provider,
    sessionsDir: runtime.sessionsDir,
  })

  runtime.sessions.set(store.id, {
    model,
    permissionMode: mode,
    store,
    toolPolicy: new Map(),
  })

  return runtime.protocolVersion === 1
    ? { modes: formatModes(mode), sessionId: store.id }
    : { configOptions: [formatModeConfigOption(mode)], sessionId: store.id }
}

const sessionNotFound = (sessionId: string, cause?: unknown): RpcError =>
  Object.assign(new RpcError(-32002, `Session not found: ${sessionId}`, { sessionId }), { cause })

const ensureSession = async (runtime: AcpRuntime, sessionId: string): Promise<AcpSessionState> => {
  const store = await openSessionStore(sessionId, runtime.sessionsDir).catch((error: unknown) => {
    throw sessionNotFound(sessionId, error)
  })
  let session = runtime.sessions.get(store.id)
  if (session == null) {
    session = {
      model: resolveRecordedModel(runtime.modelConfig ?? {}, store.header),
      permissionMode: runtime.defaultPermissionMode,
      store,
      toolPolicy: new Map(),
    }
    runtime.sessions.set(store.id, session)
  }
  return session
}

const assertSessionCwd = (session: AcpSessionState, cwd: string): void => {
  if (resolve(cwd) !== resolve(session.store.header.cwd))
    throw new RpcError(-32602, `cwd does not match the session working directory: ${session.store.header.cwd}`)
}

type SendUpdate = (update: Record<string, unknown>) => void

const replayMessageV1 = (message: Message, send: SendUpdate): void => {
  if (message.role !== 'assistant' || typeof message.content === 'string')
    return
  for (const part of message.content) {
    if (part.type === 'text')
      send({ content: { text: part.text, type: 'text' }, sessionUpdate: 'agent_message_chunk' })
  }
}

const replayMessageV2 = (message: Message, messageId: string, send: SendUpdate): void => {
  const parts = typeof message.content === 'string' ? [{ text: message.content, type: 'text' as const }] : message.content
  const content = parts.filter(part => part.type === 'text').map(part => ({ text: part.text, type: 'text' }))
  if (content.length > 0 && message.role === 'user')
    send({ content, messageId, sessionUpdate: 'user_message' })
  if (content.length > 0 && message.role === 'assistant')
    send({ content, messageId, sessionUpdate: 'agent_message' })

  for (const part of parts) {
    if (part.type === 'tool-call')
      send(toolCallUpdate(part, 2))
    else if (part.type === 'tool-result')
      send(toolResultUpdate(part))
  }
}

const replayHistory = (runtime: AcpRuntime, store: SessionStore): void => {
  const send: SendUpdate = (update) => {
    const note = sessionUpdate(store.id, update)
    runtime.sendNotification(note.method, note.params)
  }
  for (const [index, message] of buildActiveMessages(store.messages(), store.compaction()).entries()) {
    if (runtime.protocolVersion === 1)
      replayMessageV1(message, send)
    else
      replayMessageV2(message, `${store.id}:${index}`, send)
  }
}

const handleSessionLoad = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionLoadParamsSchema, params)
  const session = await ensureSession(runtime, parsed.sessionId)
  assertSessionCwd(session, parsed.cwd)
  replayHistory(runtime, session.store)
  return { modes: formatModes(session.permissionMode), sessionId: session.store.id }
}

const handleSessionResume = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(runtime.protocolVersion === 1 ? sessionLoadParamsSchema : sessionResumeParamsSchema, params)
  if ('replayFrom' in parsed && parsed.replayFrom != null && parsed.replayFrom.type !== 'start')
    throw new RpcError(-32602, `Unsupported replay cursor: ${parsed.replayFrom.type}`)
  const session = await ensureSession(runtime, parsed.sessionId)
  assertSessionCwd(session, parsed.cwd)

  if (runtime.protocolVersion === 1)
    return { modes: formatModes(session.permissionMode), sessionId: session.store.id }

  if ('replayFrom' in parsed && parsed.replayFrom != null) {
    replayHistory(runtime, session.store)
    const note = sessionUpdate(session.store.id, { sessionUpdate: 'replay_complete' })
    runtime.sendNotification(note.method, note.params)
  }
  runtime.sendSessionState(session.store.id, session.activeController == null ? 'idle' : 'running')
  return { configOptions: [formatModeConfigOption(session.permissionMode)] }
}

const handleSessionList = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionListParamsSchema, params)
  const entries = await listSessionHeaders(runtime.sessionsDir)
  return {
    sessions: entries
      .filter(({ header }) => parsed.cwd == null || resolve(header.cwd) === resolve(parsed.cwd))
      .map(({ header, updatedAt }) => ({
        cwd: header.cwd,
        sessionId: header.id,
        updatedAt: updatedAt.toISOString(),
      })),
  }
}

const findSession = (runtime: AcpRuntime, sessionId: string): AcpSessionState => {
  const session = runtime.sessions.get(sessionId)
  if (session == null)
    throw sessionNotFound(sessionId)
  return session
}

const handleSessionSetMode = (runtime: AcpRuntime, params: unknown): Record<string, unknown> => {
  const parsed = parseParams(sessionSetModeParamsSchema, params)
  const session = findSession(runtime, parsed.sessionId)
  session.permissionMode = parsed.modeId
  const note = sessionUpdate(session.store.id, { currentModeId: parsed.modeId, sessionUpdate: 'current_mode_update' })
  runtime.sendNotification(note.method, note.params)
  return {}
}

const handleSessionSetConfigOption = (runtime: AcpRuntime, params: unknown): Record<string, unknown> => {
  const parsed = parseParams(sessionSetConfigOptionParamsSchema, params)
  const session = findSession(runtime, parsed.sessionId)
  session.permissionMode = parsed.value
  return { configOptions: [formatModeConfigOption(parsed.value)] }
}

const cancelSession = (runtime: AcpRuntime, sessionId: string): void => {
  runtime.sessions.get(sessionId)?.activeController?.abort(new Error('Session cancelled'))
  for (const [reqId, pending] of runtime.pendingClientRequests.entries()) {
    if (pending.sessionId === sessionId) {
      runtime.pendingClientRequests.delete(reqId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }
}

const handleSessionClose = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionCloseParamsSchema, params)
  const session = runtime.sessions.get(parsed.sessionId)
  if (session == null)
    return {}
  cancelSession(runtime, parsed.sessionId)
  await session.turn
  runtime.sessions.delete(parsed.sessionId)
  return {}
}

const startPromptV2 = async (
  runtime: AcpRuntime,
  session: AcpSessionState,
  prompt: unknown,
  run: (onPromptInserted: () => void) => Promise<{ stopReason: AgentStopReason }>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> => {
  const messageId = randomUUID()
  const sessionId = session.store.id
  let inserted = false
  return new Promise((resolveInserted, rejectInserted) => {
    session.turn = run(() => {
      inserted = true
      const echo = sessionUpdate(sessionId, { content: prompt, messageId, sessionUpdate: 'user_message' })
      runtime.sendNotification(echo.method, echo.params)
      runtime.sendSessionState(sessionId, 'running')
      resolveInserted({ messageId })
    })
      .then(result => runtime.sendSessionState(sessionId, 'idle', mapStopReason(result.stopReason)))
      .catch((error: unknown) => {
        if (!inserted) {
          rejectInserted(signal.aborted ? new RpcError(-32800, 'Request cancelled') : error)
          return
        }
        if (signal.aborted) {
          runtime.sendSessionState(sessionId, 'idle', 'cancelled')
          return
        }
        runtime.sendSessionState(sessionId, 'idle', 'error', {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        })
      })
  })
}

const handleSessionPrompt = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionPromptParamsSchema, params)
  const session = findSession(runtime, parsed.sessionId)
  if (session.activeController != null)
    throw new RpcError(-32602, `Session ${parsed.sessionId} already has an active prompt`)

  const { images, text: promptText } = parsePromptBlocks(parsed.prompt)
  if (images.length > 0 && !session.model.supportsImageInput)
    throw new RpcError(-32602, `Model ${session.model.model} does not accept image input`)
  const controller = new AbortController()
  const linkedSignal = runtime.signal != null
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal
  session.activeController = controller

  const mapEvent = createAgentEventMapper(runtime.protocolVersion, session.store.id)
  const run = async (onPromptInserted?: () => void): Promise<Awaited<ReturnType<typeof runAgent>>> => {
    try {
      return await runAgent({
        cwd: session.store.header.cwd,
        home: runtime.modelConfig?.home,
        images,
        maxTurns: runtime.maxTurns,
        model: session.model,
        onEvent: (event) => {
          const note = mapEvent(event)
          if (note != null)
            runtime.sendNotification(note.method, note.params)
        },
        onPromptInserted,
        preToolCall: buildPreToolCall(runtime, session, linkedSignal),
        prompt: promptText,
        sessionStore: session.store,
        signal: linkedSignal,
      })
    }
    finally {
      if (session.activeController === controller)
        session.activeController = undefined
    }
  }

  if (runtime.protocolVersion === 2)
    return startPromptV2(runtime, session, parsed.prompt, run, linkedSignal)

  try {
    const result = await run()
    return {
      _meta: {
        text: result.text,
        usage: {
          cacheReadInputTokens: result.cacheStats.totalCacheReadTokens,
          inputTokens: result.cacheStats.totalInputTokens,
          outputTokens: result.cacheStats.totalOutputTokens,
        },
      },
      stopReason: mapStopReason(result.stopReason),
    }
  }
  catch (error) {
    if (linkedSignal.aborted)
      return { stopReason: 'cancelled' }
    throw error
  }
}

const v1Only = new Set(['session/load', 'session/set_mode'])
const v2Only = new Set(['session/close', 'session/list', 'session/set_config_option'])

const dispatchMethod = async (runtime: AcpRuntime, method: string, params: unknown): Promise<unknown> => {
  if (method !== 'initialize' && (runtime.protocolVersion === 1 ? v2Only : v1Only).has(method))
    throw new RpcError(-32601, `Method not found: ${method}`)

  switch (method) {
    case 'initialize':
      return handleInitialize(runtime, params)
    case 'session/cancel':
      cancelSession(runtime, parseParams(sessionCancelParamsSchema, params).sessionId)
      return {}
    case 'session/close':
      return handleSessionClose(runtime, params)
    case 'session/list':
      return handleSessionList(runtime, params)
    case 'session/load':
      return handleSessionLoad(runtime, params)
    case 'session/new':
      return handleSessionNew(runtime, params)
    case 'session/prompt':
      return handleSessionPrompt(runtime, params)
    case 'session/resume':
      return handleSessionResume(runtime, params)
    case 'session/set_config_option':
      return handleSessionSetConfigOption(runtime, params)
    case 'session/set_mode':
      return handleSessionSetMode(runtime, params)
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

const resolveClientResponse = (
  runtime: AcpRuntime,
  id: JsonRpcId,
  errorPayload: unknown,
  resultPayload: unknown,
): void => {
  const pending = runtime.pendingClientRequests.get(id)
  if (pending == null)
    return
  runtime.pendingClientRequests.delete(id)
  if (errorPayload != null)
    pending.reject(new Error('Client returned a JSON-RPC error', { cause: errorPayload }))
  else
    pending.resolve(resultPayload)
}

const handleIncomingLine = (runtime: AcpRuntime, line: string): void => {
  if (line.trim() === '')
    return

  let rawJson: unknown
  try {
    rawJson = JSON.parse(line)
  }
  catch {
    runtime.sendMessage({ error: { code: -32700, message: 'Parse error' }, id: null })
    return
  }

  const envelopeResult = v.safeParse(jsonRpcEnvelopeSchema, rawJson)
  if (!envelopeResult.success) {
    runtime.sendMessage({ error: { code: -32600, message: 'Invalid Request' }, id: null })
    return
  }

  const msg = envelopeResult.output

  if (msg.method == null) {
    if (msg.id != null)
      resolveClientResponse(runtime, msg.id, msg.error, msg.result)
    return
  }

  if (msg.id == null) {
    if (msg.method === 'session/cancel')
      cancelSession(runtime, parseParams(sessionCancelParamsSchema, msg.params).sessionId)
    return
  }

  const requestId = msg.id
  void dispatchMethod(runtime, msg.method, msg.params)
    .then((result) => {
      runtime.sendMessage({ id: requestId, result })
    })
    .catch((error: unknown) => {
      const code = error instanceof RpcError ? error.code : -32603
      const message = error instanceof Error ? error.message : 'Internal error'
      const data = error instanceof RpcError ? error.data : undefined
      runtime.sendMessage({ error: { code, ...data != null && { data }, message }, id: requestId })
    })
}

export const startAcpServer = async (options: AcpServerOptions): Promise<void> => {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  let nextClientRequestId = 1

  const sendMessage = (payload: Record<string, unknown>): void => {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`)
  }

  const runtime: AcpRuntime = {
    defaultPermissionMode: options.permissionMode ?? 'auto',
    maxTurns: options.maxTurns,
    modelConfig: options.modelConfig,
    pendingClientRequests: new Map(),
    protocolVersion: 2,
    sendMessage,
    sendNotification: (method, params) => sendMessage({ method, params }),
    sendRequestToClient: async (method, params, sessionId, signal) => {
      signal?.throwIfAborted()
      const id = nextClientRequestId++
      return new Promise<unknown>((resolvePromise, rejectPromise) => {
        const onAbort = (): void => {
          runtime.pendingClientRequests.delete(id)
          rejectPromise(signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))
        }
        runtime.pendingClientRequests.set(id, {
          reject: (err) => {
            signal?.removeEventListener('abort', onAbort)
            rejectPromise(err)
          },
          resolve: (val) => {
            signal?.removeEventListener('abort', onAbort)
            resolvePromise(val)
          },
          sessionId,
        })
        signal?.addEventListener('abort', onAbort, { once: true })
        sendMessage({ id, method, params })
      })
    },
    sendSessionState: (sessionId, state, stopReason, error) => {
      const note = sessionUpdate(sessionId, {
        sessionUpdate: 'state_update',
        state,
        ...stopReason != null && { stopReason },
        ...error != null && { error },
      })
      sendMessage({ method: note.method, params: note.params })
    },
    sessions: new Map(),
    sessionsDir: options.sessionsDir,
    signal: options.signal,
  }

  const rl = createInterface({ crlfDelay: Infinity, input })

  await new Promise<void>((resolveDone) => {
    const cleanup = (): void => {
      for (const session of runtime.sessions.values())
        session.activeController?.abort(new Error('ACP server closed'))
      for (const pending of runtime.pendingClientRequests.values())
        pending.reject(new Error('ACP server closed'))
      runtime.pendingClientRequests.clear()
      rl.close()
      resolveDone()
    }

    if (options.signal?.aborted === true) {
      cleanup()
      return
    }

    options.signal?.addEventListener('abort', cleanup, { once: true })
    rl.on('line', line => handleIncomingLine(runtime, line))
    rl.on('close', () => {
      options.signal?.removeEventListener('abort', cleanup)
      cleanup()
    })
  })
}
