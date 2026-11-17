import type { Content, ImagePart, LanguageModel, LanguageModelProviderOptions, Message, PreToolCall, StopCondition, TextEvent, TextPart, ToolCallPart, ToolResultPart, ToolResultPartContent, Usage, UserMessage } from '@xsai/text'

import type { ResolvedModelConfig } from '../providers'
import type { CacheMissEvent, CacheStats, CacheStatsSnapshot, SessionStore } from '../session'
import type { Skill } from './skills'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { collect, streamText } from '@xsai/text'

import { fwtDirs } from '../home'
import { createCacheStats } from '../session'
import { createExecManager, createTools } from '../tools'
import { buildInitialUserMessage, STATIC_SYSTEM_PROMPT } from './prompt'
import {
  collectActivatedSkillNames,
  discoverSkills,
  extractExplicitSkillNames,
  formatAvailableSkills,
  formatSkillActivation,
} from './skills'

const readAgentsInstructions = async (cwd: string, home?: string): Promise<string> => {
  const directories: string[] = []
  let directory = resolve(cwd)
  for (;;) {
    directories.push(directory)
    const parent = dirname(directory)
    if (parent === directory)
      break
    directory = parent
  }
  const instructions: string[] = []
  for (const dir of new Set([fwtDirs(home).config, ...directories.toReversed()])) {
    try {
      const contents = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      if (contents.trim() !== '')
        instructions.push(`# AGENTS.md instructions for ${dir}\n<INSTRUCTIONS>\n${contents}\n</INSTRUCTIONS>`)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
  }
  return instructions.join('\n\n')
}

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
  messages: readonly Message[]
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
  sessionStore?: SessionStore
  signal?: AbortSignal
  skills?: readonly Skill[]
}

const isEmptyWriteStdinPoll = (call: ToolCallPart): boolean => {
  if (call.name !== 'write_stdin')
    return false
  try {
    const parsed = JSON.parse(call.arguments) as { chars?: unknown }
    return parsed.chars == null || parsed.chars === ''
  }
  catch {
    return false
  }
}

const toolBatchSignature = (toolCalls: readonly ToolCallPart[]): string | undefined =>
  toolCalls.every(isEmptyWriteStdinPoll)
    ? undefined
    : toolCalls.map(call => `${call.name}:${call.arguments}`).join('\0')

const createStopCondition = (inputBudget: number, maxTurns: number | undefined, onStop: (reason: AgentStopReason, inputTokens?: number) => void): StopCondition => ({ step, steps }) => {
  if (step.usage != null && step.usage.inputTokens >= inputBudget) {
    onStop('context_limit', step.usage.inputTokens)
    return true
  }

  if (steps.length >= MAX_LOOP_REPEATS) {
    const tail = steps.slice(-MAX_LOOP_REPEATS)
    const firstSig = toolBatchSignature(tail[0].toolCalls)
    if (firstSig != null && tail.every(entry => toolBatchSignature(entry.toolCalls) === firstSig)) {
      onStop('loop_detected')
      return true
    }
  }

  if (maxTurns != null && steps.length >= maxTurns) {
    onStop('max_turns')
    return true
  }
  return false
}

const splitUserMessageToolImages = (message: Extract<Message, { role: 'user' }>): Message => {
  if (typeof message.content === 'string')
    return message

  const nextContent: (typeof message.content)[number][] = []
  const extractedImages: ImagePart[] = []

  for (const part of message.content) {
    if (part.type !== 'tool-result' || !Array.isArray(part.output)) {
      nextContent.push(part)
      continue
    }

    const images = part.output.filter(item => item.type === 'image')
    if (images.length === 0) {
      nextContent.push(part)
      continue
    }

    const texts: ToolResultPartContent[] = part.output.filter(item => item.type !== 'image')
    extractedImages.push(...images)
    nextContent.push({
      ...part,
      output: texts.length > 0 ? texts : '(see attached image)',
    })
  }

  if (extractedImages.length === 0)
    return message

  nextContent.push(...extractedImages)
  return {
    ...message,
    content: nextContent,
  }
}

const splitChatToolResultImages = (messages: readonly Message[]): Message[] =>
  messages.map(message => message.role === 'user' ? splitUserMessageToolImages(message) : message)

const withCacheControlTextPart = (part: TextPart): TextPart => ({
  ...part,
  providerMetadata: {
    ...part.providerMetadata,
    messages: {
      ...part.providerMetadata?.messages,
      cacheControl: { type: 'ephemeral' },
    },
  },
})

const applyMessagesCacheBreakpoints = (messages: readonly Message[]): Message[] => {
  const systemMessage: Message = {
    content: [withCacheControlTextPart({ text: STATIC_SYSTEM_PROMPT, type: 'text' })],
    role: 'system',
  }

  const wired = [...messages]
  for (let i = wired.length - 1; i >= 0; i -= 1) {
    const message = wired[i]
    if (message.role !== 'user' && message.role !== 'assistant')
      continue

    if (typeof message.content === 'string') {
      wired[i] = {
        ...message,
        content: [withCacheControlTextPart({ text: message.content, type: 'text' })],
      }
      break
    }

    const lastTextIndex = message.content.findLastIndex(part => part.type === 'text')
    if (lastTextIndex !== -1) {
      const nextParts = [...message.content]
      const target = nextParts[lastTextIndex] as TextPart
      nextParts[lastTextIndex] = withCacheControlTextPart(target)
      wired[i] = {
        ...message,
        content: nextParts,
      } as Message
      break
    }
  }

  return [systemMessage, ...wired]
}

const buildTurnUserMessage = async (
  options: RunAgentOptions,
  seedMessages: readonly Message[],
): Promise<Message> => {
  const skills = options.skills ?? await discoverSkills({ cwd: options.cwd })

  const alreadyActivated = collectActivatedSkillNames(seedMessages)
  const explicitNames = extractExplicitSkillNames(options.prompt, skills)
  const skillByName = new Map(skills.map(skill => [skill.name, skill]))
  const activations: string[] = []
  for (const name of explicitNames) {
    if (alreadyActivated.has(name))
      continue
    const skill = skillByName.get(name)
    if (skill != null)
      activations.push(await formatSkillActivation(skill))
  }

  const promptWithActivations = activations.length > 0
    ? `${activations.join('\n\n')}\n\n${options.prompt}`
    : options.prompt

  const message: UserMessage = seedMessages.length > 0
    ? { content: promptWithActivations, role: 'user' }
    : buildInitialUserMessage(promptWithActivations, {
        agentsInstructions: await readAgentsInstructions(options.cwd, options.home),
        availableSkillsPrompt: formatAvailableSkills(skills),
        cwd: options.cwd,
      })

  if (options.images == null || options.images.length === 0 || typeof message.content !== 'string')
    return message
  return { content: [{ text: message.content, type: 'text' }, ...options.images], role: 'user' }
}

const isRealUserMessage = (message: Message): message is UserMessage =>
  message.role === 'user'
  && (typeof message.content === 'string' || !message.content.some(part => part.type === 'tool-result'))

const estimatePart = (part: Content): { images: number, textBytes: number } => {
  if (part.type === 'text')
    return { images: 0, textBytes: Buffer.byteLength(part.text, 'utf8') }
  if (part.type === 'reasoning')
    return { images: 0, textBytes: part.content.reduce((size, item) => size + Buffer.byteLength(item.text, 'utf8'), 0) }
  if (part.type === 'tool-call')
    return { images: 0, textBytes: Buffer.byteLength(part.arguments, 'utf8') }
  if (part.type === 'tool-result') {
    if (typeof part.output === 'string')
      return { images: 0, textBytes: Buffer.byteLength(part.output, 'utf8') }
    return part.output.reduce((result, item) => {
      if (item.type === 'image')
        result.images += 1
      else
        result.textBytes += Buffer.byteLength(item.text, 'utf8')
      return result
    }, { images: 0, textBytes: 0 })
  }
  if (part.type === 'image')
    return { images: 1, textBytes: 0 }
  return { images: 0, textBytes: Buffer.byteLength(JSON.stringify(part), 'utf8') }
}

const estimateMessage = (message: Message): number => {
  if (typeof message.content === 'string')
    return Math.ceil(Buffer.byteLength(message.content, 'utf8') / 3) + 32
  const size = message.content.reduce((total, part) => {
    const estimate = estimatePart(part)
    total.images += estimate.images
    total.textBytes += estimate.textBytes
    return total
  }, { images: 0, textBytes: 0 })
  return Math.ceil(size.textBytes / 3) + size.images * 8192 + 32
}

const estimateMessages = (messages: readonly Message[], tools: unknown = [], includeEnvelope = true): number =>
  messages.reduce((total, message) => total + estimateMessage(message), includeEnvelope
    ? Math.ceil(Buffer.byteLength(`${STATIC_SYSTEM_PROMPT}${JSON.stringify(tools)}`, 'utf8') / 3)
    : 0)

const messageUnitEnd = (messages: readonly Message[], start: number): number => {
  const message = messages[start]
  if (message.role !== 'assistant' || typeof message.content === 'string')
    return start + 1
  const callIds = new Set(message.content.filter(part => part.type === 'tool-call').map(part => part.callId))
  if (callIds.size === 0)
    return start + 1
  const resultIds = new Set<string>()
  let end = start
  while (end < messages.length && resultIds.size < callIds.size) {
    const current = messages[end]
    if (current.role === 'user' && typeof current.content !== 'string') {
      for (const part of current.content) {
        if (part.type === 'tool-result' && callIds.has(part.callId))
          resultIds.add(part.callId)
      }
    }
    end += 1
  }
  return end
}

const messageUnits = (messages: readonly Message[]): { end: number, start: number, tokens: number }[] => {
  const units: { end: number, start: number, tokens: number }[] = []
  for (let start = 0; start < messages.length;) {
    const end = messageUnitEnd(messages, start)
    units.push({ end, start, tokens: estimateMessages(messages.slice(start, end), [], false) })
    start = end
  }
  return units
}

type UserMessagePart = Extract<UserMessage['content'], readonly unknown[]>[number]

const retainedUserParts = (message: UserMessage): UserMessagePart[] =>
  typeof message.content === 'string' ? [{ text: message.content, type: 'text' }] : [...message.content]

const COMPACTION_SECTIONS = [
  'Goal and unfinished requirements',
  'User corrections and active constraints',
  'Current state and changed files',
  'Decisions and rejected approaches',
  'Checks run, results, and remaining verification',
  'Running commands and exact identifiers',
  'Next action and open questions',
  'References to recover omitted details',
]

const validateSummary = (generated: Awaited<ReturnType<typeof collect>>, summary: string): string | undefined => {
  const step = generated.steps[0]
  if (step == null || step.status !== 'completed')
    return 'the model did not complete a response'
  if (step.reason === 'length')
    return 'the response was truncated by the output limit'
  if (generated.toolCalls.length > 0)
    return 'the response contained a tool call'
  if (summary === '')
    return 'the response was empty'
  if (COMPACTION_SECTIONS.some(section => !summary.includes(section)))
    return 'one or more required sections were missing'
  return undefined
}

const selectTailStartMessage = (messages: readonly Message[], inputBudget: number): number | undefined => {
  const units = messageUnits(messages)
  if (units.length === 0)
    return undefined
  const suffixBudget = Math.min(16384, Math.floor(0.15 * inputBudget))
  let start = units.length - 1
  let tokens = units[start].tokens
  while (start > 0 && tokens + units[start - 1].tokens <= suffixBudget) {
    start -= 1
    tokens += units[start].tokens
  }
  return units[start].start
}

const makeSummaryInstruction = (tailStartMessage: number, inputBudget: number, sessionFilePath: string | undefined): string => `Write a continuation summary for the conversation through raw message ${tailStartMessage}. The recent suffix starting at raw message ${tailStartMessage} will remain verbatim in the next context. Aim for no more than ${Math.min(4096, Math.floor(0.05 * inputBudget))} tokens. Treat any previous summary as prior state, and update it with new evidence. Do not claim an action succeeded without a result. Do not answer the user's task. Return only the summary. Use these eight sections exactly, and write "None" when a section has no entries:\n\n${COMPACTION_SECTIONS.join('\n')}\n\nThe summary is historical work state. The user's latest message remains the current request. ${sessionFilePath == null ? 'No session file exists, so omitted details cannot be recovered from the log; say when information is unavailable.' : `The original raw history remains in ${sessionFilePath}; use exec_command to recover omitted details when needed.`}`

const summaryRequestFailure = (currentInputTokens: number, instruction: string, contextTokens: number, outputTokens: number, margin: number): string | undefined => {
  const estimate = currentInputTokens + estimateMessage({ content: instruction, role: 'user' }) + outputTokens + margin
  return estimate > contextTokens ? `The summary request needs about ${estimate} tokens, beyond the ${contextTokens}-token context window.` : undefined
}

export const buildActiveMessages = (
  messages: readonly Message[],
  compaction: undefined | { summary: string, tailStartMessage: number },
): Message[] => {
  if (compaction == null)
    return [...messages]
  const retainedUsers = messages.slice(0, compaction.tailStartMessage).filter(isRealUserMessage)
  const retainedParts = retainedUsers.flatMap(retainedUserParts)
  retainedParts.push({ text: `Historical work state summary, not a new user request. The user's latest message remains current.\n\n${compaction.summary}`, type: 'text' })
  return [
    { content: retainedParts, role: 'user' },
    ...messages.slice(compaction.tailStartMessage),
  ]
}

const applyCompactionCacheBreakpoint = (messages: readonly Message[], index?: number): Message[] => {
  if (index == null)
    return [...messages]
  const message = messages[index]
  if (message == null || message.role !== 'user' || typeof message.content === 'string')
    return [...messages]
  const lastTextIndex = message.content.findLastIndex(part => part.type === 'text')
  if (lastTextIndex === -1)
    return [...messages]
  const content = [...message.content]
  content[lastTextIndex] = withCacheControlTextPart(content[lastTextIndex] as TextPart)
  const output = [...messages]
  output[index] = { ...message, content }
  return output
}

const requestSummary = async (options: {
  activeCompaction: undefined | { summary: string, tailStartMessage: number }
  input: Message[]
  languageModel: LanguageModel
  maxOutputTokens: number | undefined
  protocol: RunAgentOptions['model']['protocol']
  providerOptions: LanguageModelProviderOptions | undefined
  reasoningEffort: string | undefined
  signal: AbortSignal | undefined
  tools: ReturnType<typeof createTools>
}): Promise<{ failureReason?: string, summary: string, usage?: Usage }> => {
  let input = options.input
  if (options.protocol === 'messages') {
    const instruction = input.at(-1)
    input = applyMessagesCacheBreakpoints(input.slice(0, -1))
    if (options.activeCompaction != null)
      input = applyCompactionCacheBreakpoint(input, 1)
    if (instruction != null)
      input.push(instruction)
  }
  const generated = await collect(await options.languageModel({
    input,
    instructions: options.protocol === 'messages' ? undefined : STATIC_SYSTEM_PROMPT,
    maxOutputTokens: options.maxOutputTokens,
    providerOptions: options.providerOptions,
    reasoningEffort: options.reasoningEffort,
    signal: options.signal,
    tools: options.tools,
  }))
  options.signal?.throwIfAborted()
  const summary = generated.text.trim()
  return {
    failureReason: validateSummary(generated, summary),
    summary,
    usage: generated.totalUsage ?? generated.steps[0]?.usage,
  }
}

const compactedInputFailure = (messages: readonly Message[], compaction: { summary: string, tailStartMessage: number }, tools: unknown, inputBudget: number): string | undefined => {
  const estimate = estimateMessages(buildActiveMessages(messages, compaction), tools)
  const limit = Math.floor(0.4 * inputBudget)
  return estimate > limit ? `the compacted input needs about ${estimate} tokens, above the ${limit}-token limit` : undefined
}

const compactionCandidate = (
  messages: readonly Message[],
  tailStartMessage: number,
  tools: unknown,
  inputBudget: number,
  generated: { failureReason?: string, summary: string, usage?: Usage },
): { compaction?: { summary: string, tailStartMessage: number, usage: Usage }, reason?: string } => {
  if (generated.failureReason != null)
    return { reason: generated.failureReason }
  if (generated.usage == null)
    return { reason: 'the model did not return usage for the summary' }
  const compaction = { summary: generated.summary, tailStartMessage, usage: generated.usage }
  const reason = compactedInputFailure(messages, compaction, tools, inputBudget)
  return reason == null ? { compaction } : { reason }
}

const generateCompaction = async (options: {
  activeCompaction: undefined | { summary: string, tailStartMessage: number }
  contextTokens: number
  currentInputTokens: number
  inputBudget: number
  margin: number
  messages: Message[]
  model: ResolvedModelConfig
  outputTokens: number
  providerOptions: LanguageModelProviderOptions | undefined
  recordFailedUsage: (usage: Usage) => Promise<void>
  sessionFilePath: string | undefined
  sessionId: string
  signal: AbortSignal | undefined
  tailStartMessage: number
  tools: ReturnType<typeof createTools>
}): Promise<{ compaction?: { summary: string, tailStartMessage: number, usage: Usage }, reason?: string }> => {
  const summaryInstruction = makeSummaryInstruction(options.tailStartMessage, options.inputBudget, options.sessionFilePath)
  let failureReason = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    options.signal?.throwIfAborted()
    const instruction = attempt === 0
      ? summaryInstruction
      : `${summaryInstruction}\n\nCorrection: the previous summary failed because ${failureReason}. Return a corrected summary with every required section.`
    const requestFailure = summaryRequestFailure(options.currentInputTokens, instruction, options.contextTokens, options.outputTokens, options.margin)
    if (requestFailure != null)
      return { reason: requestFailure }
    const generated = await requestSummary({
      activeCompaction: options.activeCompaction,
      input: [...options.messages, { content: instruction, role: 'user' }],
      languageModel: options.model.languageModel(options.sessionId),
      maxOutputTokens: options.model.protocol === 'messages' ? options.outputTokens : undefined,
      protocol: options.model.protocol,
      providerOptions: options.providerOptions,
      reasoningEffort: options.model.effort,
      signal: options.signal,
      tools: options.tools,
    })
    const candidate = compactionCandidate(options.messages, options.tailStartMessage, options.tools, options.inputBudget, generated)
    if (candidate.compaction != null)
      return candidate
    if (generated.usage != null)
      await options.recordFailedUsage(generated.usage)
    failureReason = candidate.reason ?? 'the summary was not accepted'
  }
  return { reason: `The summary could not be adopted after one correction: ${failureReason}.` }
}

const compactConversation = async (options: {
  activeCompaction: undefined | { summary: string, tailStartMessage: number }
  cacheStats: CacheStats
  contextTokens: number
  conversation: Message[]
  inputBudget: number
  latestUsageInputTokens: number | undefined
  latestUsageMessageCount: number
  margin: number
  model: ResolvedModelConfig
  outputTokens: number
  providerOptions: LanguageModelProviderOptions | undefined
  sessionId: string
  sessionStore: SessionStore | undefined
  signal: AbortSignal | undefined
  stepNumber: number
  tools: ReturnType<typeof createTools>
}): Promise<{ activeCompaction: undefined | { summary: string, tailStartMessage: number }, latestUsageInputTokens: number | undefined, latestUsageMessageCount: number, reason?: string }> => {
  const { contextTokens, inputBudget, margin, outputTokens } = options
  if (inputBudget <= 0)
    return { activeCompaction: options.activeCompaction, latestUsageInputTokens: options.latestUsageInputTokens, latestUsageMessageCount: options.latestUsageMessageCount, reason: `The model context window (${contextTokens}) cannot fit the output limit (${outputTokens}) and safety margin (${margin}).` }
  const currentMessages = buildActiveMessages(options.conversation, options.activeCompaction)
  const currentEstimate = options.latestUsageInputTokens == null
    ? estimateMessages(currentMessages, options.tools)
    : options.latestUsageInputTokens + estimateMessages(options.conversation.slice(options.latestUsageMessageCount), [], false)
  if (currentEstimate <= Math.floor(0.8 * inputBudget))
    return { activeCompaction: options.activeCompaction, latestUsageInputTokens: options.latestUsageInputTokens, latestUsageMessageCount: options.latestUsageMessageCount }
  const tailStartMessage = selectTailStartMessage(options.conversation, inputBudget)
  if (tailStartMessage == null)
    return { activeCompaction: options.activeCompaction, latestUsageInputTokens: options.latestUsageInputTokens, latestUsageMessageCount: options.latestUsageMessageCount, reason: 'There is no complete message unit to retain.' }
  const generated = await generateCompaction({
    activeCompaction: options.activeCompaction,
    contextTokens,
    currentInputTokens: currentEstimate,
    inputBudget,
    margin,
    messages: currentMessages,
    model: options.model,
    outputTokens,
    providerOptions: options.providerOptions,
    recordFailedUsage: async (usage) => {
      options.cacheStats.recordCompaction(usage)
      await options.sessionStore?.appendUsage({ model: options.model.model, stepNumber: options.stepNumber, usage })
    },
    sessionFilePath: options.sessionStore?.filePath,
    sessionId: options.sessionId,
    signal: options.signal,
    tailStartMessage,
    tools: options.tools,
  })
  if (generated.reason != null)
    return { activeCompaction: options.activeCompaction, latestUsageInputTokens: options.latestUsageInputTokens, latestUsageMessageCount: options.latestUsageMessageCount, reason: generated.reason }
  const compaction = generated.compaction!
  options.signal?.throwIfAborted()
  if (options.sessionStore != null) {
    await options.sessionStore.appendCompaction(compaction)
  }
  else {
    options.cacheStats.recordCompaction(compaction.usage)
    options.cacheStats.resetExpected()
  }
  return { activeCompaction: compaction, latestUsageInputTokens: undefined, latestUsageMessageCount: 0 }
}

const prepareAgentStep = async (options: {
  activeCompaction: () => undefined | { summary: string, tailStartMessage: number }
  compact: () => Promise<string | undefined>
  conversation: Message[]
  flushToolResults: () => Promise<void>
  onContextLimit: (reason: string) => void
  protocol: RunAgentOptions['model']['protocol']
  setRequestMessageCount: (count: number) => void
}): Promise<{ input: Message[], instructions?: undefined }> => {
  await options.flushToolResults()
  const reason = await options.compact()
  if (reason != null) {
    options.onContextLimit(reason)
    throw new Error(`context_limit: ${reason}`)
  }
  const activeCompaction = options.activeCompaction()
  const activeMessages = buildActiveMessages(options.conversation, activeCompaction)
  options.setRequestMessageCount(options.conversation.length)
  if (options.protocol === 'chat')
    return { input: splitChatToolResultImages(activeMessages) }
  if (options.protocol === 'messages') {
    let input = applyMessagesCacheBreakpoints(activeMessages)
    if (activeCompaction != null)
      input = applyCompactionCacheBreakpoint(input, 1)
    return { input, instructions: undefined }
  }
  return { input: activeMessages }
}

const handleAgentEvent = async (event: TextEvent, options: {
  flushToolResults: () => Promise<void>
  onEvent: RunAgentOptions['onEvent']
  pendingToolResults: ToolResultPart[]
  recordStepEnd: (event: Extract<TextEvent, { type: 'step.end' }>) => Promise<void>
  setLastText: (text: string) => void
  stepNumber: number
}): Promise<void> => {
  switch (event.type) {
    case 'content.end':
      if (event.content.type === 'tool-call') {
        options.onEvent?.({ call: event.content, type: 'tool.call' })
      }
      else if (event.content.type === 'tool-result') {
        options.pendingToolResults.push(event.content)
        options.onEvent?.({ result: event.content, type: 'tool.result' })
      }
      else if (event.content.type === 'text') {
        options.setLastText(event.content.text)
      }
      break
    case 'content.start':
    case 'raw':
    case 'refusal.delta':
    case 'tool-call.delta':
      break
    case 'reasoning.delta':
      options.onEvent?.({ delta: event.delta, type: 'reasoning.delta' })
      break
    case 'step.end':
      await options.recordStepEnd(event)
      break
    case 'step.start':
      await options.flushToolResults()
      options.onEvent?.({ stepNumber: options.stepNumber, type: 'step.start' })
      break
    case 'text.delta':
      options.onEvent?.({ delta: event.delta, type: 'text.delta' })
      break
  }
}

export const runAgent = async (options: RunAgentOptions): Promise<AgentRunResult> => {
  options.signal?.throwIfAborted()

  const execManager = createExecManager({ defaultCwd: options.cwd })
  const tools = createTools({ cwd: options.cwd, execManager, supportsImageInput: options.model.supportsImageInput })
  const contextTokens = options.model.contextTokens
  const outputTokens = options.model.maxOutputTokens
  const margin = Math.max(2048, Math.ceil(0.02 * contextTokens))
  const inputBudget = contextTokens - outputTokens - margin
  const cacheStats = options.sessionStore?.cacheStats ?? createCacheStats()

  const seedMessages = [...options.sessionStore?.messages() ?? []]

  const nextUserMessage = await buildTurnUserMessage(options, seedMessages)

  if (options.sessionStore != null)
    await options.sessionStore.appendMessage(nextUserMessage)

  options.onPromptInserted?.()

  const conversation: Message[] = [...seedMessages, nextUserMessage]
  let pendingToolResults: ToolResultPart[] = []
  const flushToolResults = async (): Promise<void> => {
    if (pendingToolResults.length === 0)
      return
    const batchMessage: Message = { content: pendingToolResults, role: 'user' }
    pendingToolResults = []
    conversation.push(batchMessage)
    if (options.sessionStore != null)
      await options.sessionStore.appendMessage(batchMessage)
  }
  let activeCompaction: undefined | { summary: string, tailStartMessage: number } = options.sessionStore?.compaction()
  const usageBaseline = options.sessionStore?.usageBaseline()
  let latestUsageInputTokens = usageBaseline?.inputTokens
  let latestUsageMessageCount = usageBaseline?.messageCount ?? 0
  let requestMessageCount = conversation.length
  let stepNumber = 0
  let stopReasonDetail: string | undefined
  const providerOptions: LanguageModelProviderOptions | undefined = options.model.protocol === 'messages'
    ? { messages: { cacheControl: { type: 'ephemeral' } } }
    : undefined
  const sessionId = options.sessionStore?.id ?? randomUUID()

  let stopReason: AgentStopReason = 'completed'

  const compact = async (): Promise<string | undefined> => {
    const state = await compactConversation({
      activeCompaction,
      cacheStats,
      contextTokens,
      conversation,
      inputBudget,
      latestUsageInputTokens,
      latestUsageMessageCount,
      margin,
      model: options.model,
      outputTokens,
      providerOptions,
      sessionId,
      sessionStore: options.sessionStore,
      signal: options.signal,
      stepNumber,
      tools,
    })
    activeCompaction = state.activeCompaction
    latestUsageInputTokens = state.latestUsageInputTokens
    latestUsageMessageCount = state.latestUsageMessageCount
    return state.reason
  }

  const compactionReason = await compact()
  if (compactionReason != null) {
    stopReason = 'context_limit'
    stopReasonDetail = compactionReason
    execManager.dispose()
    return {
      cacheStats: cacheStats.snapshot(),
      messages: conversation,
      steps: 0,
      stopReason,
      stopReasonDetail,
      text: '',
    }
  }

  const stopWhen = createStopCondition(inputBudget, options.maxTurns, (reason, inputTokens) => {
    stopReason = reason
    if (inputTokens != null)
      stopReasonDetail = `The request used ${inputTokens} input tokens, at or above the ${inputBudget}-token input budget.`
  })

  const stream = streamText(options.model.languageModel(sessionId), {
    input: [...conversation],
    instructions: STATIC_SYSTEM_PROMPT,
    maxOutputTokens: options.model.protocol === 'messages' ? options.model.maxOutputTokens : undefined,
    prepareStep: async () => prepareAgentStep({
      activeCompaction: () => activeCompaction,
      compact,
      conversation,
      flushToolResults,
      onContextLimit: (reason) => {
        stopReason = 'context_limit'
        stopReasonDetail = reason
      },
      protocol: options.model.protocol,
      setRequestMessageCount: (count) => { requestMessageCount = count },
    }),
    preToolCall: options.preToolCall,
    providerOptions,
    reasoningEffort: options.model.effort,
    signal: options.signal,
    stopWhen,
    tools,
  })

  const reader = stream.getReader()
  let lastText = ''
  let completedSteps = 0

  const recordStepEnd = async (
    event: Extract<TextEvent, { type: 'step.end' }>,
  ): Promise<void> => {
    if (event.status === 'failed')
      throw event.error
    if (event.status === 'cancelled') {
      options.signal?.throwIfAborted()
      stopReason = 'aborted'
      return
    }

    completedSteps += 1
    conversation.push(event.message)
    if (options.sessionStore != null)
      await options.sessionStore.appendMessage(event.message)

    if (event.usage != null) {
      latestUsageInputTokens = event.usage.inputTokens
      latestUsageMessageCount = requestMessageCount
      const miss = cacheStats.record(event.usage, stepNumber)
      if (options.sessionStore != null) {
        await options.sessionStore.appendUsage({
          cacheMiss: miss,
          model: event.model,
          stepNumber,
          usage: event.usage,
        })
      }
      if (miss != null)
        options.onEvent?.({ miss, type: 'cache.miss' })
    }

    options.onEvent?.({
      reason: event.reason,
      stepNumber,
      type: 'step.end',
      usage: event.usage,
    })
    stepNumber += 1
  }

  try {
    while (true) {
      const { done, value: event } = await reader.read()
      if (done)
        break

      await handleAgentEvent(event, {
        flushToolResults,
        onEvent: options.onEvent,
        pendingToolResults,
        recordStepEnd,
        setLastText: (text) => { lastText = text },
        stepNumber,
      })
    }

    await flushToolResults()
    await options.sessionStore?.flush()
  }
  catch (error) {
    if (stopReasonDetail == null)
      throw error
  }
  finally {
    await reader.cancel().catch(() => {})
    execManager.dispose()
  }

  return {
    cacheStats: cacheStats.snapshot(),
    messages: conversation,
    steps: completedSteps,
    stopReason,
    stopReasonDetail,
    text: lastText,
  }
}
