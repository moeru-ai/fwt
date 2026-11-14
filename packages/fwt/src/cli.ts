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
import { addProvider, listProviders, removeProvider, resolveModel, resolveRecordedModel } from './providers'
import { createSessionStore, openSessionStore } from './session'

interface CreateFwtCliOptions {
  fetch?: (request: Request) => Promise<Response>
  home?: string
  modelsDevUrl?: string
}

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
    schema: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1))),
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
    schema: v.optional(v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1))),
  },
])

const STOP_REASON_EXIT_CODES: Record<AgentStopReason, number> = {
  aborted: 130,
  completed: 0,
  context_limit: 3,
  loop_detected: 4,
  max_turns: 5,
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

export const createFwtCli = (options: CreateFwtCliOptions = {}): Cli => {
  const sessionsDir = join(fwtDirs(options.home).state, 'sessions')
  const resolveCwd = (io: CliIo, cwd: string | undefined): string => resolve(io.cwd ?? process.cwd(), cwd ?? '')
  const runAcp = async ({ flags, io, signal }: CommandContext<typeof modelFlags>): Promise<void> => startAcpServer({
    defaultCwd: resolveCwd(io, flags.cwd),
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
    description: 'Run the dual-version (v1 + v2) ACP JSON-RPC stdio server',
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

      let prompt = flags.prompt ?? args.prompt
      if ((prompt == null || prompt.trim() === '') && io.stdin != null && io.stdin.isTTY !== true)
        prompt = await text(io.stdin)

      if (prompt == null || prompt.trim() === '')
        throw new UsageError('Provide a prompt with -p/--prompt, positional text, or stdin.')

      const modelInput = buildModelInput(flags, options)
      const resumed = flags.resume != null && flags.resume !== '' ? await openSessionStore(flags.resume, sessionsDir) : undefined
      const resolvedModel = resumed == null ? resolveModel(modelInput) : resolveRecordedModel(modelInput, resumed.header)
      const sessionStore = resumed ?? await createSessionStore({
        cwd: resolveCwd(io, flags.cwd),
        model: resolvedModel.model,
        protocol: resolvedModel.protocol,
        provider: resolvedModel.provider,
        sessionsDir,
      })

      const outputFormat = flags.output ?? 'text'
      let streamedText = false

      const result = await runAgent({
        cwd: sessionStore.header.cwd,
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
        const { cacheStats, steps, stopReason, text: finalText } = result
        io.stdout.write(`${JSON.stringify({ cacheStats, sessionId: sessionStore.id, steps, stopReason, text: finalText, type: 'result' })}\n`)
      }
      else {
        if (!streamedText)
          io.stdout.write(result.text)
        if ((streamedText || result.text !== '') && !result.text.endsWith('\n'))
          io.stdout.write('\n')
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
      { description: 'Resume an existing session by ID, path, or "latest"', flag: '-r, --resume <session>' },
      { description: 'Output format', flag: '-o, --output <text|jsonl>' },
      { description: 'Run ACP stdio server (alias for `fwt acp`)', flag: '--acp' },
    ],
    help: 'Headless coding agent. Exit codes: 0 completed, 3 context window used up, 4 repeated tool calls detected, 5 --max-turns reached, 130 aborted.',
    name: 'fwt',
    version,
  })
}
