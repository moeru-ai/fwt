import type { ImagePart, LanguageModelProviderOptions, Message, PreToolCall, StopCondition, TextEvent, TextPart, ToolCallPart, ToolResultPart, ToolResultPartContent, Usage, UserMessage } from '@xsai/text'

import type { ResolvedModelConfig } from '../providers'
import type { CacheMissEvent, CacheStatsSnapshot, SessionStore } from '../session'
import type { Skill } from './skills'

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { streamText } from '@xsai/text'

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
const CONTEXT_WARNING_RATIO = 0.85
const CONTEXT_WINDOW_REMINDER = `<context_window_reminder>You have used ${CONTEXT_WARNING_RATIO * 100}% of the context window. Finish essential verification and deliver a clear final answer rather than starting broad new exploration.</context_window_reminder>`

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

export const runAgent = async (options: RunAgentOptions): Promise<AgentRunResult> => {
  options.signal?.throwIfAborted()

  const execManager = createExecManager({ defaultCwd: options.cwd })
  const tools = createTools({ cwd: options.cwd, execManager, supportsImageInput: options.model.supportsImageInput })
  const inputBudget = options.model.contextTokens - options.model.maxOutputTokens
  const cacheStats = options.sessionStore?.cacheStats ?? createCacheStats()

  const seedMessages = [...options.sessionStore?.messages() ?? []]

  const nextUserMessage = await buildTurnUserMessage(options, seedMessages)

  if (options.sessionStore != null)
    await options.sessionStore.appendMessage(nextUserMessage)

  options.onPromptInserted?.()

  const conversation: Message[] = [...seedMessages, nextUserMessage]
  const providerOptions: LanguageModelProviderOptions | undefined = options.model.protocol === 'messages'
    ? { messages: { cacheControl: { type: 'ephemeral' } } }
    : undefined

  let pendingContextReminder = false
  let reminderMessageIndex: number | undefined
  let appendReminderToNextFlush = false
  let stopReason: AgentStopReason = 'completed'

  const applyContextReminder = (messages: readonly Message[]): readonly Message[] => {
    if (reminderMessageIndex == null)
      return messages
    const target = messages[reminderMessageIndex]
    if (target == null || target.role !== 'user' || typeof target.content === 'string')
      return messages
    return messages.with(reminderMessageIndex, {
      ...target,
      content: [...target.content, { text: CONTEXT_WINDOW_REMINDER, type: 'text' }],
    })
  }

  const stopWhen: StopCondition = ({ step, steps }) => {
    if (step.usage != null && step.usage.inputTokens >= inputBudget) {
      stopReason = 'context_limit'
      return true
    }

    if (steps.length >= MAX_LOOP_REPEATS) {
      const tail = steps.slice(-MAX_LOOP_REPEATS)
      const firstSig = toolBatchSignature(tail[0].toolCalls)
      if (firstSig != null && tail.every(entry => toolBatchSignature(entry.toolCalls) === firstSig)) {
        stopReason = 'loop_detected'
        return true
      }
    }

    if (options.maxTurns != null && steps.length >= options.maxTurns) {
      stopReason = 'max_turns'
      return true
    }

    if (
      reminderMessageIndex == null
      && step.usage != null
      && step.usage.inputTokens >= Math.floor(inputBudget * CONTEXT_WARNING_RATIO)
    ) {
      pendingContextReminder = true
    }

    return false
  }

  const stream = streamText(options.model.languageModel(options.sessionStore?.id ?? randomUUID()), {
    input: [...conversation],
    instructions: STATIC_SYSTEM_PROMPT,
    maxOutputTokens: options.model.protocol === 'messages' ? options.model.maxOutputTokens : undefined,
    prepareStep: ({ input }) => {
      if (pendingContextReminder && reminderMessageIndex == null) {
        const lastIndex = input.length - 1
        const lastMessage = input[lastIndex]
        if (lastMessage.role === 'user' && typeof lastMessage.content !== 'string') {
          reminderMessageIndex = lastIndex
          pendingContextReminder = false
          appendReminderToNextFlush = true
        }
      }

      const effectiveInput = applyContextReminder(input)

      if (options.model.protocol === 'chat')
        return { input: splitChatToolResultImages(effectiveInput) }

      if (options.model.protocol === 'messages') {
        return {
          input: applyMessagesCacheBreakpoints(effectiveInput),
          instructions: undefined,
        }
      }

      return reminderMessageIndex != null ? { input: [...effectiveInput] } : undefined
    },
    preToolCall: options.preToolCall,
    providerOptions,
    reasoningEffort: options.model.effort,
    signal: options.signal,
    stopWhen,
    tools,
  })

  const reader = stream.getReader()
  let stepNumber = 0
  let lastText = ''
  let pendingToolResults: ToolResultPart[] = []
  let completedSteps = 0

  const flushToolResults = async (): Promise<void> => {
    if (pendingToolResults.length === 0)
      return
    const content: (TextPart | ToolResultPart)[] = appendReminderToNextFlush
      ? [...pendingToolResults, { text: CONTEXT_WINDOW_REMINDER, type: 'text' }]
      : pendingToolResults
    appendReminderToNextFlush = false
    const batchMessage: Message = { content, role: 'user' }
    pendingToolResults = []
    conversation.push(batchMessage)
    if (options.sessionStore != null)
      await options.sessionStore.appendMessage(batchMessage)
  }

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

      switch (event.type) {
        case 'content.end':
          if (event.content.type === 'tool-call') {
            options.onEvent?.({ call: event.content, type: 'tool.call' })
          }
          else if (event.content.type === 'tool-result') {
            pendingToolResults.push(event.content)
            options.onEvent?.({ result: event.content, type: 'tool.result' })
          }
          else if (event.content.type === 'text') {
            lastText = event.content.text
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
          await recordStepEnd(event)
          break

        case 'step.start':
          await flushToolResults()
          options.onEvent?.({ stepNumber, type: 'step.start' })
          break

        case 'text.delta':
          options.onEvent?.({ delta: event.delta, type: 'text.delta' })
          break
      }
    }

    await flushToolResults()
    await options.sessionStore?.flush()
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
    text: lastText,
  }
}
