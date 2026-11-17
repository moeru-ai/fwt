import type { ImagePart, PreToolCall, StopCondition, TextEvent, ToolCallPart, ToolResultPart, Usage, UserMessage } from '@xsai/text'

import type { ResolvedModelConfig } from '../providers'
import type { CacheMissEvent, CacheStatsSnapshot, SessionStore } from '../session'
import type { Skill } from './skills'

import { streamText } from '@xsai/text'

import { fwtDirs } from '../home'
import { readConfig } from '../providers'
import { createExecManager, createTools } from '../tools'
import { buildActiveMessages, compactIfNeeded, contextBudget } from './compaction'
import { buildInitialUserMessage, STATIC_SYSTEM_PROMPT, toWireRequest } from './prompt'
import {
  collectActivatedSkillNames,
  discoverSkills,
  extractExplicitSkillNames,
  formatAvailableSkills,
  formatSkillActivation,
} from './skills'

const MAX_LOOP_REPEATS = 3

export type AgentEvent
  = | { call: ToolCallPart, type: 'tool.call' }
    | { delta: string, type: 'reasoning.delta' }
    | { delta: string, type: 'text.delta' }
    | { miss: CacheMissEvent, type: 'cache.miss' }
    | { reason?: string, stepNumber: number, type: 'step.end', usage?: Usage }
    | { result: ToolResultPart, type: 'tool.result' }
    | { stepNumber: number, type: 'step.start' }

export type AgentStopReason = 'aborted' | 'completed' | 'context_limit' | 'loop_detected' | 'max_turns'

interface AgentRunResult {
  cacheStats: CacheStatsSnapshot
  steps: number
  stopReason: AgentStopReason
  stopReasonDetail?: string
  text: string
}

interface RunAgentOptions {
  cwd: string
  home?: string
  images?: readonly ImagePart[]
  maxTurns?: number
  model: ResolvedModelConfig
  onEvent?: (event: AgentEvent) => void
  onPromptInserted?: () => void
  preToolCall?: PreToolCall
  prompt: string
  sessionStore: SessionStore
  signal?: AbortSignal
  skills?: readonly Skill[]
}

const toolBatchSignature = (toolCalls: readonly ToolCallPart[]): string | undefined => {
  const isEmptyPoll = (call: ToolCallPart): boolean => {
    if (call.name !== 'write_stdin')
      return false
    try {
      const { chars } = JSON.parse(call.arguments) as { chars?: unknown }
      return chars == null || chars === ''
    }
    catch {
      return false
    }
  }
  return toolCalls.every(isEmptyPoll) ? undefined : toolCalls.map(call => `${call.name}:${call.arguments}`).join('\0')
}

const createStopCondition = (
  inputBudget: number,
  maxTurns: number | undefined,
  onStop: (reason: AgentStopReason, detail?: string) => void,
): StopCondition => ({ step, steps }) => {
  if (step.usage != null && step.usage.inputTokens >= inputBudget) {
    onStop('context_limit', `The request used ${step.usage.inputTokens} input tokens, at or above the ${inputBudget}-token input budget.`)
    return true
  }
  const signature = steps.length >= MAX_LOOP_REPEATS ? toolBatchSignature(steps.at(-MAX_LOOP_REPEATS)!.toolCalls) : undefined
  if (signature != null && steps.slice(-MAX_LOOP_REPEATS).every(entry => toolBatchSignature(entry.toolCalls) === signature)) {
    onStop('loop_detected')
    return true
  }
  if (maxTurns != null && steps.length >= maxTurns) {
    onStop('max_turns')
    return true
  }
  return false
}

const buildTurnUserMessage = async (options: RunAgentOptions): Promise<UserMessage> => {
  const history = options.sessionStore.messages()
  const skills = options.skills ?? await discoverSkills({ cwd: options.cwd })
  const activated = collectActivatedSkillNames(history)
  const activations = await Promise.all(extractExplicitSkillNames(options.prompt, skills)
    .filter(name => !activated.has(name))
    .flatMap(name => skills.filter(skill => skill.name === name))
    .map(formatSkillActivation))
  const prompt = [...activations, options.prompt].join('\n\n')

  const message = history.length > 0
    ? { content: prompt, role: 'user' as const }
    : await buildInitialUserMessage(prompt, { availableSkillsPrompt: formatAvailableSkills(skills), cwd: options.cwd, home: options.home })
  return options.images == null || options.images.length === 0
    ? message
    : { content: [{ text: message.content, type: 'text' }, ...options.images], role: 'user' }
}

export const runAgent = async (options: RunAgentOptions): Promise<AgentRunResult> => {
  options.signal?.throwIfAborted()

  const { model, sessionStore: store } = options
  const execManager = createExecManager({ defaultCwd: options.cwd, shell: readConfig(fwtDirs(options.home)).shell })
  const tools = createTools({ cwd: options.cwd, execManager, supportsImageInput: model.supportsImageInput })
  const languageModel = model.languageModel(store.id)
  const providerOptions = model.protocol === 'messages' ? { messages: { cacheControl: { type: 'ephemeral' as const } } } : undefined

  await store.appendMessage(await buildTurnUserMessage(options))
  options.onPromptInserted?.()

  let stopReason: AgentStopReason = 'completed'
  let stopReasonDetail: string | undefined
  let stepNumber = 0
  let completedSteps = 0
  let lastText = ''
  let pendingToolResults: ToolResultPart[] = []
  const stop = (reason: AgentStopReason, detail?: string): void => {
    stopReason = reason
    stopReasonDetail = detail
  }
  const flushToolResults = async (): Promise<void> => {
    if (pendingToolResults.length === 0)
      return
    const content = pendingToolResults
    pendingToolResults = []
    await store.appendMessage({ content, role: 'user' })
  }

  const recordStepEnd = async (event: Extract<TextEvent, { type: 'step.end' }>): Promise<void> => {
    if (event.status === 'failed')
      throw event.error
    if (event.status === 'cancelled') {
      options.signal?.throwIfAborted()
      stopReason = 'aborted'
      return
    }
    completedSteps += 1
    await store.appendMessage(event.message)
    const miss = event.usage == null ? undefined : await store.appendUsage({ model: event.model, stepNumber, usage: event.usage })
    if (miss != null)
      options.onEvent?.({ miss, type: 'cache.miss' })
    options.onEvent?.({ reason: event.reason, stepNumber, type: 'step.end', usage: event.usage })
    stepNumber += 1
  }

  const recordContent = (content: Extract<TextEvent, { type: 'content.end' }>['content']): void => {
    if (content.type === 'tool-call') {
      options.onEvent?.({ call: content, type: 'tool.call' })
    }
    else if (content.type === 'tool-result') {
      pendingToolResults.push(content)
      options.onEvent?.({ result: content, type: 'tool.result' })
    }
    else if (content.type === 'text') {
      lastText = content.text
    }
  }

  const stream = streamText(languageModel, {
    input: [...store.messages()],
    instructions: STATIC_SYSTEM_PROMPT,
    maxOutputTokens: model.protocol === 'messages' ? model.maxOutputTokens : undefined,
    prepareStep: async () => {
      await flushToolResults()
      const reason = await compactIfNeeded({ languageModel, model, providerOptions, signal: options.signal, stepNumber, store, tools })
      if (reason != null) {
        stop('context_limit', reason)
        throw new Error(`context_limit: ${reason}`)
      }
      const compaction = store.compaction()
      return toWireRequest(buildActiveMessages(store.messages(), compaction), model.protocol, compaction != null)
    },
    preToolCall: options.preToolCall,
    providerOptions,
    reasoningEffort: model.effort,
    signal: options.signal,
    stopWhen: createStopCondition(contextBudget(model).inputBudget, options.maxTurns, stop),
    tools,
  })

  try {
    for await (const event of stream) {
      if (event.type === 'step.end')
        await recordStepEnd(event)
      else if (event.type === 'content.end')
        recordContent(event.content)
      else if (event.type === 'step.start')
        options.onEvent?.({ stepNumber, type: 'step.start' })
      else if (event.type === 'reasoning.delta' || event.type === 'text.delta')
        options.onEvent?.({ delta: event.delta, type: event.type })
    }
    await flushToolResults()
    await store.flush()
  }
  catch (error) {
    if (stopReasonDetail == null)
      throw error
  }
  finally {
    execManager.dispose()
  }

  return { cacheStats: store.cacheStats.snapshot(), steps: completedSteps, stopReason, stopReasonDetail, text: lastText }
}
