import type { Content, LanguageModel, LanguageModelProviderOptions, Message, Tool, Usage, UserMessage } from '@xsai/text'

import type { ResolvedModelConfig } from '../providers'
import type { SessionCompactionRecord, SessionStore } from '../session'

import { Buffer } from 'node:buffer'

import { collect } from '@xsai/text'

import { STATIC_SYSTEM_PROMPT, toWireRequest } from './prompt'

const SUMMARY_SECTIONS = [
  'Goal and unfinished requirements',
  'User corrections and active constraints',
  'Current state and changed files',
  'Decisions and rejected approaches',
  'Checks run, results, and remaining verification',
  'Running commands and exact identifiers',
  'Next action and open questions',
  'References to recover omitted details',
]

type Compaction = Pick<SessionCompactionRecord, 'summary' | 'tailStartMessage'>

export const contextBudget = (model: Pick<ResolvedModelConfig, 'contextTokens' | 'maxOutputTokens'>): { inputBudget: number, margin: number } => {
  const margin = Math.max(2048, Math.ceil(0.02 * model.contextTokens))
  return { inputBudget: model.contextTokens - model.maxOutputTokens - margin, margin }
}

const isRealUserMessage = (message: Message): message is UserMessage =>
  message.role === 'user'
  && (typeof message.content === 'string' || !message.content.some(part => part.type === 'tool-result'))

export const buildActiveMessages = (messages: readonly Message[], compaction: Compaction | undefined): Message[] => {
  if (compaction == null)
    return [...messages]
  const retained = messages.slice(0, compaction.tailStartMessage).filter(isRealUserMessage).flatMap(message =>
    typeof message.content === 'string' ? [{ text: message.content, type: 'text' as const }] : message.content)
  return [
    { content: [...retained, { text: `Historical work state summary, not a new user request. The user's latest message remains current.\n\n${compaction.summary}`, type: 'text' }], role: 'user' },
    ...messages.slice(compaction.tailStartMessage),
  ]
}

const partSize = (part: Content): { bytes: number, images: number } => {
  switch (part.type) {
    case 'audio':
    case 'file':
    case 'provider':
    case 'refusal':
      return { bytes: Buffer.byteLength(JSON.stringify(part)), images: 0 }
    case 'image':
      return { bytes: 0, images: 1 }
    case 'reasoning':
      return { bytes: part.content.reduce((size, item) => size + Buffer.byteLength(item.text), 0), images: 0 }
    case 'text':
      return { bytes: Buffer.byteLength(part.text), images: 0 }
    case 'tool-call':
      return { bytes: Buffer.byteLength(part.arguments), images: 0 }
    case 'tool-result':
      return typeof part.output === 'string'
        ? { bytes: Buffer.byteLength(part.output), images: 0 }
        : part.output.map(partSize).reduce((a, b) => ({ bytes: a.bytes + b.bytes, images: a.images + b.images }), { bytes: 0, images: 0 })
  }
}

const estimateMessages = (messages: readonly Message[]): number => messages.reduce((total, message) => {
  const parts = typeof message.content === 'string' ? [{ text: message.content, type: 'text' as const }] : message.content
  const size = parts.map(partSize).reduce((a, b) => ({ bytes: a.bytes + b.bytes, images: a.images + b.images }), { bytes: 0, images: 0 })
  return total + Math.ceil(size.bytes / 3) + size.images * 8192 + 32
}, 0)

const estimateRequest = (messages: readonly Message[], tools: readonly Tool[]): number =>
  Math.ceil(Buffer.byteLength(`${STATIC_SYSTEM_PROMPT}${JSON.stringify(tools)}`) / 3) + estimateMessages(messages)

const unitEnd = (messages: readonly Message[], start: number): number => {
  const message = messages[start]
  const callIds = new Set(message.role === 'assistant' && typeof message.content !== 'string'
    ? message.content.flatMap(part => part.type === 'tool-call' ? [part.callId] : [])
    : [])
  let end = start + 1
  while (callIds.size > 0 && end < messages.length) {
    const current = messages[end]
    if (current.role === 'user' && typeof current.content !== 'string') {
      for (const part of current.content) {
        if (part.type === 'tool-result')
          callIds.delete(part.callId)
      }
    }
    end += 1
  }
  return end
}

const selectTailStart = (messages: readonly Message[], inputBudget: number): number => {
  const units: { start: number, tokens: number }[] = []
  for (let start = 0; start < messages.length;) {
    const end = unitEnd(messages, start)
    units.push({ start, tokens: estimateMessages(messages.slice(start, end)) })
    start = end
  }
  const suffixBudget = Math.min(16384, Math.floor(0.15 * inputBudget))
  let index = units.length - 1
  let tokens = units[index].tokens
  while (index > 0 && tokens + units[index - 1].tokens <= suffixBudget) {
    index -= 1
    tokens += units[index].tokens
  }
  return units[index].start
}

const summaryInstruction = (tailStartMessage: number, inputBudget: number, sessionFile: string): string => `Write a continuation summary for the conversation through raw message ${tailStartMessage}. The recent suffix starting at raw message ${tailStartMessage} will remain verbatim in the next context. Aim for no more than ${Math.min(4096, Math.floor(0.05 * inputBudget))} tokens. Treat any previous summary as prior state, and update it with new evidence. Do not claim an action succeeded without a result. Do not answer the user's task. Return only the summary. Use these eight sections exactly, and write "None" when a section has no entries:\n\n${SUMMARY_SECTIONS.join('\n')}\n\nThe summary is historical work state. The user's latest message remains the current request. The original raw history remains in ${sessionFile}; use exec_command to recover omitted details when needed.`

const summaryFailure = (generated: Awaited<ReturnType<typeof collect>>, summary: string): string | undefined => {
  const step = generated.steps[0]
  if (step == null || step.status !== 'completed')
    return 'the model did not complete a response'
  if (step.reason === 'length')
    return 'the response was truncated by the output limit'
  if (generated.toolCalls.length > 0)
    return 'the response contained a tool call'
  if (summary === '')
    return 'the response was empty'
  if (SUMMARY_SECTIONS.some(section => !summary.includes(section)))
    return 'one or more required sections were missing'
  return undefined
}

interface CompactionOptions {
  languageModel: LanguageModel
  model: ResolvedModelConfig
  providerOptions: LanguageModelProviderOptions | undefined
  signal: AbortSignal | undefined
  stepNumber: number
  store: SessionStore
  tools: readonly Tool[]
}

const summarize = async (
  options: CompactionOptions,
  request: { input: Message[], instructions?: string },
  instruction: string,
  tailStartMessage: number,
): Promise<{ failure?: string, summary: string, usage?: Usage }> => {
  const { model } = options
  const generated = await collect(await options.languageModel({
    input: [...request.input, { content: instruction, role: 'user' }],
    instructions: request.instructions,
    maxOutputTokens: model.protocol === 'messages' ? model.maxOutputTokens : undefined,
    providerOptions: options.providerOptions,
    reasoningEffort: model.effort,
    signal: options.signal,
    tools: [...options.tools],
  }))
  options.signal?.throwIfAborted()
  const summary = generated.text.trim()
  const usage = generated.totalUsage ?? generated.steps[0]?.usage
  const compacted = estimateRequest(buildActiveMessages(options.store.messages(), { summary, tailStartMessage }), options.tools)
  const limit = Math.floor(0.4 * contextBudget(model).inputBudget)
  const failure = summaryFailure(generated, summary)
    ?? (usage == null ? 'the model did not return usage for the summary' : undefined)
    ?? (compacted > limit ? `the compacted input needs about ${compacted} tokens, above the ${limit}-token limit` : undefined)
  return { failure, summary, usage }
}

export const compactIfNeeded = async (options: CompactionOptions): Promise<string | undefined> => {
  const { model, store } = options
  const { inputBudget, margin } = contextBudget(model)
  if (inputBudget <= 0)
    return `The model context window (${model.contextTokens}) cannot fit the output limit (${model.maxOutputTokens}) and safety margin (${margin}).`

  const messages = store.messages()
  const active = buildActiveMessages(messages, store.compaction())
  const baseline = store.usageBaseline()
  const currentTokens = baseline == null
    ? estimateRequest(active, options.tools)
    : baseline.inputTokens + estimateMessages(messages.slice(baseline.messageCount))
  if (currentTokens <= Math.floor(0.8 * inputBudget))
    return undefined

  const tailStartMessage = selectTailStart(messages, inputBudget)
  const instruction = summaryInstruction(tailStartMessage, inputBudget, store.filePath)
  const request = toWireRequest(active, model.protocol, store.compaction() != null)
  let failure: string | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = failure == null ? instruction : `${instruction}\n\nCorrection: the previous summary failed because ${failure}. Return a corrected summary with every required section.`
    const needed = currentTokens + estimateMessages([{ content, role: 'user' }]) + model.maxOutputTokens + margin
    if (needed > model.contextTokens)
      return `The summary request needs about ${needed} tokens, beyond the ${model.contextTokens}-token context window.`
    const result = await summarize(options, request, content, tailStartMessage)
    failure = result.failure
    if (failure == null && result.usage != null) {
      await store.appendCompaction({ summary: result.summary, tailStartMessage, usage: result.usage })
      return undefined
    }
    if (result.usage != null)
      await store.appendUsage({ model: model.model, stepNumber: options.stepNumber, usage: result.usage })
  }
  return `The summary could not be adopted after one correction: ${failure}.`
}
