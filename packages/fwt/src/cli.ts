import type { Cli, CliIo, CommandContext } from '@moeru/cliff'

import type { AgentStopReason } from './agent'
import type { ModelConfigInput, WireProtocol } from './providers'

import process from 'node:process'

import { join, resolve } from 'node:path'
import { text } from 'node:stream/consumers'

import { createCli, defineCommand, defineFlags, UsageError } from '@moeru/cliff'

import * as v from 'valibot'

import { version } from '../package.json' with { type: 'json' }
import { startAcpServer } from './acp'
import { runAgent } from './agent'
import { fwtDirs } from './home'
import { addProvider, listProviders, nonEmpty, positiveInteger, removeProvider, resolveModel, resolveRecordedModel } from './providers'
import { createSessionStore, forkSessionStore, openSessionStore } from './session'
import { readImageFile } from './tools'

interface CreateFwtCliOptions {
  fetch?: (request: Request) => Promise<Response>
  home?: string
  modelsDevUrl?: string
}

const positiveIntegerFlag = v.optional(v.pipe(v.string(), v.toNumber(), positiveInteger))

const modelFlags = defineFlags([
  { description: 'Working directory for workspace commands', flag: '--cwd <path>' },
  { description: 'Model identifier', flag: '-m, --model <model>' },
  { description: 'Provider ID from config.toml', flag: '--provider <provider>' },
  { description: 'Wire protocol override', flag: '--protocol <chat|responses|messages>' },
  { description: 'API base URL override', flag: '--base-url <url>' },
  { description: 'API key override', flag: '--api-key <key>' },
  { description: 'Reasoning effort, passed through as is (e.g. low, high, max)', flag: '--effort <effort>' },
  {
    description: 'Context window in tokens, overriding config.toml and models.dev (default: 250000)',
    flag: '--context-length <tokens>',
    schema: positiveIntegerFlag,
  },
  {
    description: 'Extra HTTP header "name: value"; repeatable, and {session} becomes the session ID',
    flag: '--header <header...>',
    schema: v.pipe(
      v.optional(v.array(v.pipe(v.string(), v.regex(/^[^:]+:/, 'Expected --header "name: value".'))), []),
      v.transform(list => Object.fromEntries(list.map((header) => {
        const colon = header.indexOf(':')
        return [header.slice(0, colon).trim(), header.slice(colon + 1).trim()]
      }))),
    ),
  },
  { description: 'ACP tool permission mode; ask sends session/request_permission before each tool call', flag: '--permission-mode <auto|ask>' },
  {
    description: 'Maximum model steps per prompt (default: no limit)',
    flag: '--max-turns <count>',
    schema: positiveIntegerFlag,
  },
])

const STOP_REASON_EXIT_CODES: Record<AgentStopReason, number> = {
  aborted: 130,
  completed: 0,
  context_limit: 3,
  loop_detected: 4,
  max_turns: 5,
}

const writeContextLimitDetail = (io: CliIo, reason: AgentStopReason, detail: string | undefined): void => {
  if (reason !== 'context_limit' || detail == null)
    return
  io.stderr.write(`[context_limit] ${detail}\n`)
}

const providerAddFlags = defineFlags([
  { description: 'Base URL; sets the provider up manually instead of from models.dev', flag: '--base-url <url>' },
  { description: 'Wire protocol of --base-url', flag: '--protocol <chat|responses|messages>' },
  { description: 'API key', flag: '--api-key <key>' },
  { description: 'Model ID to use with this provider', flag: '-m, --model <model>' },
  { description: 'Make it the default provider without asking', flag: '--default <yes|no>' },
])

const buildModelInput = (
  flags: {
    apiKey?: string
    baseUrl?: string
    contextLength?: number
    effort?: string
    header: Record<string, string>
    model?: string
    protocol?: WireProtocol
    provider?: string
  },
  options: CreateFwtCliOptions,
): ModelConfigInput => ({
  apiKey: flags.apiKey,
  baseURL: flags.baseUrl,
  contextLength: flags.contextLength,
  effort: flags.effort,
  fetch: options.fetch,
  headers: flags.header,
  home: options.home,
  model: flags.model,
  protocol: flags.protocol,
  provider: flags.provider,
})

const readPrompt = async (prompt: string | undefined, io: CliIo): Promise<string> => {
  const hasPrompt = prompt != null && prompt.trim() !== ''
  if (io.stdin == null || io.stdin.isTTY === true) {
    if (!hasPrompt)
      throw new UsageError('Provide a prompt with -p/--prompt, positional text, or stdin.')
    return prompt
  }
  if (hasPrompt)
    io.stderr.write('Reading additional input from stdin...\n')
  const stdinText = await text(io.stdin)
  if (!hasPrompt) {
    if (stdinText.trim() === '')
      throw new UsageError('Provide a prompt with -p/--prompt, positional text, or stdin.')
    return stdinText
  }
  if (stdinText === '')
    return prompt
  return `${prompt}\n\n<stdin>\n${stdinText}${stdinText.endsWith('\n') ? '' : '\n'}</stdin>`
}

export const createFwtCli = (options: CreateFwtCliOptions = {}): Cli => {
  const sessionsDir = join(fwtDirs(options.home).state, 'sessions')
  const resolveCwd = (io: CliIo, cwd: string | undefined): string => resolve(io.cwd ?? process.cwd(), cwd ?? '')
  const getRunSession = async (flags: Parameters<typeof buildModelInput>[0] & { cwd?: string, fork?: string, resume?: string }, io: CliIo) => {
    const resume = nonEmpty(flags.resume)
    const fork = nonEmpty(flags.fork)
    if (resume != null && fork != null)
      throw new UsageError('--resume and --fork cannot be used together.')
    const runCwd = resolveCwd(io, flags.cwd)
    const sessionRef = resume ?? fork
    const source = sessionRef == null ? undefined : await openSessionStore(sessionRef, sessionsDir, runCwd)
    const modelInput = buildModelInput(flags, options)
    const model = source == null ? resolveModel(modelInput) : resolveRecordedModel(modelInput, source.header)
    const recorded = { model: model.model, protocol: model.protocol, provider: model.provider, sessionsDir }
    const sessionStore = source == null
      ? await createSessionStore({ ...recorded, cwd: runCwd })
      : fork == null ? source : await forkSessionStore(source, { ...recorded, cwd: flags.cwd == null ? undefined : runCwd })
    return { model, previousCwd: source?.header.cwd, sessionStore }
  }
  const runAcp = async ({ flags, io, signal }: CommandContext<typeof modelFlags>): Promise<void> => startAcpServer({
    input: io.stdin ?? process.stdin,
    maxTurns: flags.maxTurns,
    modelConfig: buildModelInput(flags, options),
    output: io.stdout,
    permissionMode: flags.permissionMode ?? 'auto',
    sessionsDir,
    signal,
  })

  const acpCommand = defineCommand({
    action: runAcp,
    description: 'Run the ACP v1 and v2 JSON-RPC stdio server',
    flags: modelFlags,
    name: 'acp',
  })

  const providerCommand = defineCommand({
    children: [
      defineCommand({
        action: async ({ args, flags, io, signal }) => {
          await addProvider({
            apiKey: flags.apiKey,
            baseURL: flags.baseUrl,
            fetch: options.fetch,
            home: options.home,
            io,
            makeDefault: flags.default == null ? undefined : flags.default === 'yes',
            model: flags.model,
            modelsDevUrl: options.modelsDevUrl,
            protocol: flags.protocol,
            provider: args.id,
            signal,
          })
        },
        arguments: [{ description: 'Provider ID: a models.dev ID, or a new name for a manual provider', name: 'id' }],
        description: 'Add or update a provider',
        flags: providerAddFlags,
        name: 'add',
      }),
      defineCommand({
        action: ({ io }) => listProviders({ home: options.home, io }),
        alias: ['ls'],
        description: 'List configured providers',
        name: 'list',
      }),
      defineCommand({
        action: async ({ args, io }) => {
          if (args.id == null || args.id === '')
            throw new UsageError('Provide a provider ID to remove.')
          await removeProvider({ home: options.home, io, provider: args.id })
        },
        alias: ['rm'],
        arguments: [{ description: 'Provider ID', name: 'id' }],
        description: 'Remove a provider and its saved key',
        name: 'remove',
      }),
    ],
    description: 'Manage model providers in config.toml',
    name: 'provider',
  })

  return createCli({
    action: async (context) => {
      const { args, flags, io, signal } = context
      if (flags.acp)
        return runAcp(context)
      if (flags.permissionMode === 'ask')
        throw new UsageError('--permission-mode ask needs an ACP client; use it with `fwt acp`.')

      let prompt = await readPrompt(flags.prompt ?? args.prompt, io)

      const { model: resolvedModel, previousCwd, sessionStore } = await getRunSession(flags, io)
      const cwd = sessionStore.header.cwd
      if (flags.image.length > 0 && !resolvedModel.supportsImageInput)
        throw new UsageError(`Model "${resolvedModel.model}" does not accept image input.`)
      const images = await Promise.all(flags.image.map(async path => readImageFile(path, cwd)))
      if (previousCwd != null && previousCwd !== cwd)
        prompt = `<environment_context>\ncwd: ${cwd}\n</environment_context>\n\nThis session was forked from a session in ${previousCwd}. Earlier messages refer to files under ${previousCwd}; use the same relative paths under ${cwd}, and do not change files under ${previousCwd}.\n\n${prompt}`

      const outputFormat = flags.output ?? 'text'
      let streamedText = false

      const result = await runAgent({
        cwd,
        home: options.home,
        images,
        maxTurns: flags.maxTurns,
        model: resolvedModel,
        onEvent: (event) => {
          if (outputFormat === 'jsonl') {
            const payload = JSON.stringify(event)
            io.stdout.write(`${payload}\n`)
            return
          }
          if (event.type === 'text.delta') {
            streamedText = true
            io.stdout.write(event.delta)
          }
          else if (event.type === 'cache.miss') {
            io.stderr.write(`[cache-miss] step=${event.miss.stepNumber} missed=${event.miss.missedTokens}\n`)
          }
        },
        prompt,
        sessionStore,
        signal,
      })

      if (outputFormat === 'jsonl') {
        const { cacheStats, steps, stopReason, stopReasonDetail, text: finalText } = result
        io.stdout.write(`${JSON.stringify({ cacheStats, sessionId: sessionStore.id, steps, stopReason, stopReasonDetail, text: finalText, type: 'result' })}\n`)
      }
      else {
        if (!streamedText)
          io.stdout.write(result.text)
        if ((streamedText || result.text !== '') && !result.text.endsWith('\n'))
          io.stdout.write('\n')
        writeContextLimitDetail(io, result.stopReason, result.stopReasonDetail)
      }
      return STOP_REASON_EXIT_CODES[result.stopReason]
    },
    arguments: [{ description: 'Prompt text when -p is omitted', name: 'prompt' }],
    children: [
      acpCommand,
      providerCommand,
    ],
    description: 'Headless coding agent',
    flags: [
      ...modelFlags,
      { description: 'Prompt text to execute headlessly', flag: '-p, --prompt <text>' },
      {
        description: 'Image to include in the prompt; repeatable',
        flag: '-i, --image <path...>',
        schema: v.optional(v.array(v.string()), []),
      },
      { description: 'Resume an existing session by ID, path, or "latest"', flag: '-r, --resume <session>' },
      { description: 'Fork an existing session by ID, path, or "latest"', flag: '--fork <session>' },
      { description: 'Output format', flag: '-o, --output <text|jsonl>' },
      { description: 'Run ACP stdio server (alias for `fwt acp`)', flag: '--acp' },
    ],
    help: 'Headless coding agent. Exit codes: 0 completed, 3 context window used up, 4 repeated tool calls detected, 5 --max-turns reached, 130 aborted.',
    name: 'fwt',
    version,
  })
}
