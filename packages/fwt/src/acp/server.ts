import type { PreToolCall, ToolCallPart, ToolResultPart } from '@xsai/text'

import type { ModelConfigInput, ResolvedModelConfig } from '../providers'
import type { SessionStore } from '../session'
import type { AcpProtocolVersion, AcpServerOptions, PermissionMode, PermissionOutcome } from './types'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import * as v from 'valibot'

import { version } from '../../package.json' with { type: 'json' }
import { runAgent } from '../agent'
import { resolveModel, resolveRecordedModel } from '../providers'
import { createSessionStore, openSessionStore } from '../session'
import {
  createAgentEventMapper,
  extractPromptText,
  formatModeConfigOption,
  formatModes,
  initializeParamsSchema,
  jsonRpcEnvelopeSchema,
  mapStopReason,
  negotiateProtocolVersion,
  parseParams,
  parsePermissionOutcome,
  RpcError,
  safeJsonParse,
  sessionCancelParamsSchema,
  sessionLoadParamsSchema,
  sessionNewParamsSchema,
  sessionPromptParamsSchema,
  sessionResumeParamsSchema,
  sessionSetConfigOptionParamsSchema,
  sessionSetModeParamsSchema,
  sessionUpdate,
  toolKind,
} from './protocol'

interface AcpRuntime {
  defaultCwd: string
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

interface AcpSessionState {
  activeController?: AbortController
  model: ResolvedModelConfig
  permissionMode: PermissionMode
  store: SessionStore
  toolPolicy: Map<string, 'allow' | 'reject'>
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

    const toolCall = {
      kind: toolKind(call.name),
      rawInput: safeJsonParse(call.arguments),
      title: call.name,
      toolCallId: call.callId,
    }
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
            ? { subject: { toolCall: { ...toolCall, name: call.name }, type: 'tool_call' }, title: `Run ${call.name}` }
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
    if (outcome === 'cancelled')
      throw new Error('Cancelled')

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

  if (runtime.protocolVersion === 1) {
    return {
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false },
        sessionCapabilities: { resume: {} },
      },
      agentInfo: { name: 'fwt', version },
      authMethods: [],
      protocolVersion: 1,
    }
  }

  return {
    authMethods: [],
    capabilities: { session: { prompt: {} } },
    info: { name: 'fwt', version },
    protocolVersion: 2,
  }
}

const handleSessionNew = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionNewParamsSchema, params)
  const model = resolveModel(runtime.modelConfig)
  const cwd = parsed.cwd != null && parsed.cwd !== '' ? parsed.cwd : runtime.defaultCwd
  const mode = runtime.defaultPermissionMode

  const store = await createSessionStore({
    cwd,
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

const replayHistory = (runtime: AcpRuntime, store: SessionStore): void => {
  const send = (update: Record<string, unknown>): void => {
    const note = sessionUpdate(store.id, update)
    runtime.sendNotification(note.method, note.params)
  }
  const v1 = runtime.protocolVersion === 1

  for (const message of store.messages()) {
    if (message.role === 'user' && typeof message.content === 'string' && !v1) {
      send({ content: [{ text: message.content, type: 'text' }], messageId: randomUUID(), sessionUpdate: 'user_message' })
    }
    else if (message.role === 'assistant' && typeof message.content !== 'string') {
      for (const part of message.content.filter(part => part.type === 'text')) {
        send(v1
          ? { content: { text: part.text, type: 'text' }, sessionUpdate: 'agent_message_chunk' }
          : { content: [{ text: part.text, type: 'text' }], messageId: randomUUID(), sessionUpdate: 'agent_message' })
      }
    }
  }
}

const handleSessionLoad = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionLoadParamsSchema, params)
  const session = await ensureSession(runtime, parsed.sessionId)
  replayHistory(runtime, session.store)
  return { modes: formatModes(session.permissionMode), sessionId: session.store.id }
}

const handleSessionResume = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  if (runtime.protocolVersion === 1) {
    const parsed = parseParams(sessionLoadParamsSchema, params)
    const session = await ensureSession(runtime, parsed.sessionId)
    return { modes: formatModes(session.permissionMode), sessionId: session.store.id }
  }

  const parsed = parseParams(sessionResumeParamsSchema, params)
  const session = await ensureSession(runtime, parsed.sessionId)
  if (parsed.replayFrom?.type === 'start') {
    replayHistory(runtime, session.store)
    const note = sessionUpdate(session.store.id, { sessionUpdate: 'replay_complete' })
    runtime.sendNotification(note.method, note.params)
  }
  runtime.sendSessionState(session.store.id, session.activeController == null ? 'idle' : 'running')
  return { configOptions: [formatModeConfigOption(session.permissionMode)] }
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

const cancelSession = (runtime: AcpRuntime, params: unknown): void => {
  const parsed = parseParams(sessionCancelParamsSchema, params)
  const session = runtime.sessions.get(parsed.sessionId)
  session?.activeController?.abort(new Error('Session cancelled'))
  for (const [reqId, pending] of runtime.pendingClientRequests.entries()) {
    if (pending.sessionId === parsed.sessionId) {
      runtime.pendingClientRequests.delete(reqId)
      pending.resolve({ outcome: { outcome: 'cancelled' } })
    }
  }
}

const handleSessionPrompt = async (runtime: AcpRuntime, params: unknown): Promise<Record<string, unknown>> => {
  const parsed = parseParams(sessionPromptParamsSchema, params)
  const session = findSession(runtime, parsed.sessionId)
  if (session.activeController != null)
    throw new RpcError(-32602, `Session ${parsed.sessionId} already has an active prompt`)

  const promptText = extractPromptText(parsed.prompt)
  const controller = new AbortController()
  const linkedSignal = runtime.signal != null
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal
  session.activeController = controller

  const mapEvent = createAgentEventMapper(runtime.protocolVersion, session.store.id)
  const run = async (): Promise<Awaited<ReturnType<typeof runAgent>>> => {
    try {
      return await runAgent({
        cwd: session.store.header.cwd,
        maxTurns: runtime.maxTurns,
        model: session.model,
        onEvent: (event) => {
          const note = mapEvent(event)
          if (note != null)
            runtime.sendNotification(note.method, note.params)
        },
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

  if (runtime.protocolVersion === 2) {
    const messageId = randomUUID()
    const echo = sessionUpdate(session.store.id, {
      content: parsed.prompt,
      messageId,
      sessionUpdate: 'user_message',
    })
    runtime.sendNotification(echo.method, echo.params)
    runtime.sendSessionState(session.store.id, 'running')
    void run()
      .then(result => runtime.sendSessionState(session.store.id, 'idle', mapStopReason(result.stopReason)))
      .catch((error: unknown) => {
        if (linkedSignal.aborted) {
          runtime.sendSessionState(session.store.id, 'idle', 'cancelled')
          return
        }
        runtime.sendSessionState(session.store.id, 'idle', 'error', {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error',
        })
      })
    return { messageId }
  }

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
const v2Only = new Set(['session/set_config_option'])

const dispatchMethod = async (runtime: AcpRuntime, method: string, params: unknown): Promise<unknown> => {
  if (method !== 'initialize' && (runtime.protocolVersion === 1 ? v2Only : v1Only).has(method))
    throw new RpcError(-32601, `Method not found: ${method}`)

  switch (method) {
    case 'initialize':
      return handleInitialize(runtime, params)
    case 'session/cancel':
      cancelSession(runtime, params)
      return {}
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
      cancelSession(runtime, msg.params)
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
    defaultCwd: options.defaultCwd ?? process.cwd(),
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
