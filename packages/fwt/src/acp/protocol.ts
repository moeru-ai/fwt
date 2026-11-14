import type { ImagePart } from '@xsai/text'

import type { AgentEvent, AgentStopReason } from '../agent'
import type { AcpProtocolVersion, PermissionMode, PermissionOutcome } from './types'

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
  value: v.picklist(['ask', 'auto']),
})

export const sessionSetModeParamsSchema = v.object({
  modeId: v.picklist(['ask', 'auto']),
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

const permissionResponseSchema = v.object({
  outcome: v.variant('outcome', [
    v.object({
      optionId: v.picklist(['allow_always', 'allow_once', 'reject_always', 'reject_once']),
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

export const toolKind = (name: string): 'execute' | 'read' => name === 'view_image' ? 'read' : 'execute'

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

export const safeJsonParse = (raw: string): unknown => {
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

export const formatModes = (currentModeId: PermissionMode): {
  availableModes: { description: string, id: PermissionMode, name: string }[]
  currentModeId: PermissionMode
} => ({
  availableModes: [
    { description: 'Run tools locally without confirmation prompts.', id: 'auto', name: 'Auto' },
    { description: 'Request permission before running each tool.', id: 'ask', name: 'Ask' },
  ],
  currentModeId,
})

const mapAgentEventV1 = (
  sessionId: string,
  event: AgentEvent,
): AcpNotification | undefined => {
  switch (event.type) {
    case 'cache.miss':
    case 'step.end':
    case 'step.start':
      return undefined
    case 'reasoning.delta':
      return {
        method: 'session/update',
        params: {
          sessionId,
          update: { content: { text: event.delta, type: 'text' }, sessionUpdate: 'agent_thought_chunk' },
        },
      }
    case 'text.delta':
      return {
        method: 'session/update',
        params: {
          sessionId,
          update: { content: { text: event.delta, type: 'text' }, sessionUpdate: 'agent_message_chunk' },
        },
      }
    case 'tool.call':
      return {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            kind: toolKind(event.call.name),
            rawInput: safeJsonParse(event.call.arguments),
            sessionUpdate: 'tool_call',
            status: 'in_progress',
            title: event.call.name,
            toolCallId: event.call.callId,
          },
        },
      }
    case 'tool.result':
      return {
        method: 'session/update',
        params: {
          sessionId,
          update: {
            rawOutput: event.result.output,
            sessionUpdate: 'tool_call_update',
            status: event.result.isError === true ? 'failed' : 'completed',
            toolCallId: event.result.callId,
          },
        },
      }
  }
}

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
  options: [
    { description: 'Run tools locally without confirmation prompts.', name: 'Auto', value: 'auto' },
    { description: 'Request permission before running each tool.', name: 'Ask', value: 'ask' },
  ],
  type: 'select',
})

export const createAgentEventMapper = (
  version: AcpProtocolVersion,
  sessionId: string,
): ((event: AgentEvent) => AcpNotification | undefined) => {
  if (version === 1)
    return event => mapAgentEventV1(sessionId, event)

  let messageId = randomUUID()
  let thoughtId = randomUUID()
  return (event) => {
    switch (event.type) {
      case 'cache.miss':
      case 'step.end':
        return undefined
      case 'reasoning.delta':
        return sessionUpdate(sessionId, {
          content: { text: event.delta, type: 'text' },
          messageId: thoughtId,
          sessionUpdate: 'agent_thought_chunk',
        })
      case 'step.start':
        messageId = randomUUID()
        thoughtId = randomUUID()
        return undefined
      case 'text.delta':
        return sessionUpdate(sessionId, {
          content: { text: event.delta, type: 'text' },
          messageId,
          sessionUpdate: 'agent_message_chunk',
        })
      case 'tool.call':
        return sessionUpdate(sessionId, {
          kind: toolKind(event.call.name),
          name: event.call.name,
          rawInput: safeJsonParse(event.call.arguments),
          sessionUpdate: 'tool_call_update',
          status: 'in_progress',
          title: event.call.name,
          toolCallId: event.call.callId,
        })
      case 'tool.result':
        return sessionUpdate(sessionId, {
          rawOutput: event.result.output,
          sessionUpdate: 'tool_call_update',
          status: event.result.isError === true ? 'failed' : 'completed',
          toolCallId: event.result.callId,
        })
    }
  }
}
