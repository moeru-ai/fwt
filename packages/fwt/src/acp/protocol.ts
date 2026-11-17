import type { ImagePart, ToolCallPart, ToolResultPart } from '@xsai/text'

import type { AgentEvent, AgentStopReason } from '../agent'

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import * as v from 'valibot'

export const jsonRpcEnvelopeSchema = v.looseObject({
  error: v.optional(v.unknown()),
  id: v.optional(v.union([v.string(), v.number()])),
  jsonrpc: v.literal('2.0'),
  method: v.optional(v.string()),
  params: v.optional(v.unknown()),
  result: v.optional(v.unknown()),
})

export type AcpProtocolVersion = 1 | 2

const permissionModeSchema = v.picklist(['ask', 'auto'])

export type PermissionMode = v.InferOutput<typeof permissionModeSchema>

const absolutePathSchema = v.pipe(v.string(), v.check(isAbsolute, 'Expected an absolute path'))

export const initializeParamsSchema = v.object({
  info: v.optional(v.looseObject({ name: v.string(), version: v.string() })),
  protocolVersion: v.pipe(v.number(), v.integer(), v.maxValue(65_535)),
})

export const sessionNewParamsSchema = v.object({
  cwd: absolutePathSchema,
})

export const sessionListParamsSchema = v.object({
  cwd: v.optional(v.nullable(absolutePathSchema)),
})

export const sessionCloseParamsSchema = v.object({
  sessionId: v.string(),
})

export const sessionLoadParamsSchema = v.object({
  cwd: absolutePathSchema,
  sessionId: v.string(),
})

export const sessionResumeParamsSchema = v.object({
  cwd: absolutePathSchema,
  replayFrom: v.optional(v.nullable(v.looseObject({ type: v.string() }))),
  sessionId: v.string(),
})

export const sessionSetConfigOptionParamsSchema = v.object({
  configId: v.literal('mode'),
  sessionId: v.string(),
  type: v.literal('id'),
  value: permissionModeSchema,
})

export const sessionSetModeParamsSchema = v.object({
  modeId: permissionModeSchema,
  sessionId: v.string(),
})

export const sessionCancelParamsSchema = v.object({
  sessionId: v.string(),
})

const promptBlockSchema = v.variant('type', [
  v.looseObject({ text: v.string(), type: v.literal('text') }),
  v.looseObject({
    data: v.string(),
    mimeType: v.picklist(['image/gif', 'image/jpeg', 'image/png', 'image/webp']),
    type: v.literal('image'),
  }),
  v.looseObject({
    resource: v.looseObject({ text: v.string(), uri: v.string() }),
    type: v.literal('resource'),
  }),
  v.looseObject({ name: v.string(), type: v.literal('resource_link'), uri: v.string() }),
])

export const sessionPromptParamsSchema = v.object({
  prompt: v.pipe(v.array(promptBlockSchema), v.minLength(1)),
  sessionId: v.string(),
})

const permissionOptionSchema = v.picklist(['allow_always', 'allow_once', 'reject_always', 'reject_once'])

export type PermissionOutcome = 'cancelled' | v.InferOutput<typeof permissionOptionSchema>

const permissionResponseSchema = v.object({
  outcome: v.variant('outcome', [
    v.object({
      optionId: permissionOptionSchema,
      outcome: v.literal('selected'),
    }),
    v.object({ outcome: v.literal('cancelled') }),
  ]),
})

export class RpcError extends Error {
  readonly code: number
  readonly data?: Record<string, unknown>

  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.data = data
  }
}

const toolKind = (name: string): 'execute' | 'read' => name === 'view_image' ? 'read' : 'execute'

export const parseParams = <TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  params: unknown,
): v.InferOutput<TSchema> => {
  const parsed = v.safeParse(schema, params ?? {})
  if (!parsed.success) {
    const issue = parsed.issues[0]
    const at = v.getDotPath(issue)
    throw new RpcError(-32602, `Invalid params${at != null ? ` at ${at}` : ''}: ${issue.message}`)
  }
  return parsed.output
}

const safeJsonParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  }
  catch {
    return raw
  }
}

export const negotiateProtocolVersion = (requested: number): AcpProtocolVersion => {
  if (requested < 1)
    throw new RpcError(-32022, `Unsupported protocol version: ${requested}`, { requested, supported: [1, 2] })
  return requested === 1 ? 1 : 2
}

export const parsePromptBlocks = (
  prompt: v.InferOutput<typeof sessionPromptParamsSchema>['prompt'],
): { images: ImagePart[], text: string } => {
  const images: ImagePart[] = []
  const texts: string[] = []
  for (const block of prompt) {
    switch (block.type) {
      case 'image':
        images.push({ data: `data:${block.mimeType};base64,${block.data}`, type: 'image' })
        break
      case 'resource':
        texts.push(`<resource uri="${block.resource.uri}">\n${block.resource.text}\n</resource>`)
        break
      case 'resource_link':
        texts.push(`[${block.name}](${block.uri})`)
        break
      case 'text':
        texts.push(block.text)
        break
    }
  }
  return { images, text: texts.join('\n') }
}

export const parsePermissionOutcome = (value: unknown): PermissionOutcome => {
  const parsed = v.safeParse(permissionResponseSchema, value)
  if (!parsed.success)
    return 'reject_once'
  const { outcome } = parsed.output
  return outcome.outcome === 'cancelled' ? 'cancelled' : outcome.optionId
}

export const mapStopReason = (reason: AgentStopReason): string => {
  switch (reason) {
    case 'aborted':
      return 'cancelled'
    case 'completed':
      return 'end_turn'
    case 'context_limit':
      return 'max_tokens'
    case 'loop_detected':
    case 'max_turns':
      return 'max_turn_requests'
  }
}

const MODES = [
  { description: 'Run tools locally without confirmation prompts.', id: 'auto', name: 'Auto' },
  { description: 'Request permission before running each tool.', id: 'ask', name: 'Ask' },
] as const satisfies readonly { description: string, id: PermissionMode, name: string }[]

export const formatModes = (currentModeId: PermissionMode): Record<string, unknown> => ({
  availableModes: MODES,
  currentModeId,
})

export interface AcpNotification {
  method: 'session/update'
  params: Record<string, unknown>
}

export const sessionUpdate = (sessionId: string, update: Record<string, unknown>): AcpNotification => ({
  method: 'session/update',
  params: { sessionId, update },
})

export const formatModeConfigOption = (currentValue: PermissionMode): Record<string, unknown> => ({
  category: 'mode',
  configId: 'mode',
  currentValue,
  name: 'Mode',
  options: MODES.map(({ description, id, name }) => ({ description, name, value: id })),
  type: 'select',
})

export const toolCallFields = (call: ToolCallPart, version: AcpProtocolVersion): Record<string, unknown> => ({
  kind: toolKind(call.name),
  ...version === 2 && { name: call.name },
  rawInput: safeJsonParse(call.arguments),
  title: call.name,
  toolCallId: call.callId,
})

export const toolCallUpdate = (call: ToolCallPart, version: AcpProtocolVersion): Record<string, unknown> => ({
  ...toolCallFields(call, version),
  sessionUpdate: version === 1 ? 'tool_call' : 'tool_call_update',
  status: 'in_progress',
})

export const toolResultUpdate = (result: ToolResultPart): Record<string, unknown> => ({
  rawOutput: result.output,
  sessionUpdate: 'tool_call_update',
  status: result.isError === true ? 'failed' : 'completed',
  toolCallId: result.callId,
})

export const createAgentEventMapper = (
  version: AcpProtocolVersion,
  sessionId: string,
): ((event: AgentEvent) => AcpNotification | undefined) => {
  let messageId = randomUUID()
  let thoughtId = randomUUID()
  const chunk = (sessionUpdateKind: string, text: string, id: string): AcpNotification =>
    sessionUpdate(sessionId, { content: { text, type: 'text' }, ...version === 2 && { messageId: id }, sessionUpdate: sessionUpdateKind })
  return (event) => {
    switch (event.type) {
      case 'cache.miss':
      case 'step.end':
        return undefined
      case 'reasoning.delta':
        return chunk('agent_thought_chunk', event.delta, thoughtId)
      case 'step.start':
        messageId = randomUUID()
        thoughtId = randomUUID()
        return undefined
      case 'text.delta':
        return chunk('agent_message_chunk', event.delta, messageId)
      case 'tool.call':
        return sessionUpdate(sessionId, toolCallUpdate(event.call, version))
      case 'tool.result':
        return sessionUpdate(sessionId, toolResultUpdate(event.result))
    }
  }
}
