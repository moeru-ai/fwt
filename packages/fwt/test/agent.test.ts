import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { AgentEvent } from '../src/agent'
import type { WireProtocol } from '../src/providers'

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sleep } from '@moeru/std'
import { afterEach, describe, expect, it } from 'vitest'

import { discoverSkills, runAgent } from '../src/agent'
import { resolveModel } from '../src/providers'
import { createSessionStore, openSessionStore } from '../src/session'

interface MockServer {
  baseURL: string
  close: () => Promise<void>
  headers: Record<string, string | string[] | undefined>[]
  requests: Record<string, unknown>[]
}

type SseScriptHandler = (
  body: Record<string, unknown>,
  requestIndex: number,
  res: ServerResponse,
  req: IncomingMessage,
) => Promise<void> | void

const writeSse = (res: ServerResponse, chunks: unknown[], rawStrings: string[] = []): void => {
  res.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': 'text/event-stream',
  })
  for (const chunk of chunks)
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  for (const raw of rawStrings)
    res.write(raw)
  res.end()
}

const createMockServer = async (handler: SseScriptHandler): Promise<MockServer> => {
  const requests: Record<string, unknown>[] = []
  const headers: Record<string, string | string[] | undefined>[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of req)
        chunks.push(chunk as Uint8Array)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const parsed = rawBody === '' ? {} : JSON.parse(rawBody) as Record<string, unknown>
      requests.push(parsed)
      headers.push(req.headers)
      await handler(parsed, requests.length - 1, res, req)
    })()
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: async () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    }),
    headers,
    requests,
  }
}

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])

describe('runAgent multi-protocol integration', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()
      if (fn != null)
        await fn()
    }
  })

  const makeTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-agent-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))
    return dir
  }

  const startServer = async (handler: SseScriptHandler): Promise<MockServer> => {
    const server = await createMockServer(handler)
    cleanups.push(server.close)
    return server
  }

  const runProtocolToolLoop = async (protocol: WireProtocol): Promise<void> => {
    const dir = await makeTempDir()
    const server = await startServer((_body, idx, res) => {
      if (protocol === 'chat') {
        if (idx === 0) {
          writeSse(res, [
            {
              choices: [{
                delta: {
                  role: 'assistant',
                  tool_calls: [{
                    function: { arguments: '{"cmd":"echo hello-chat"}', name: 'exec_command' },
                    id: 'call_1',
                    index: 0,
                    type: 'function',
                  }],
                },
                finish_reason: null,
                index: 0,
              }],
            },
            {
              choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
              usage: { completion_tokens: 12, prompt_tokens: 100, total_tokens: 112 },
            },
          ], ['data: [DONE]\n\n'])
          return
        }
        writeSse(res, [
          { choices: [{ delta: { content: 'done-chat', role: 'assistant' }, finish_reason: null, index: 0 }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
            usage: { completion_tokens: 8, prompt_cache_hit_tokens: 90, prompt_tokens: 150, total_tokens: 158 },
          },
        ], ['data: [DONE]\n\n'])
        return
      }

      if (protocol === 'responses') {
        if (idx === 0) {
          const callItem = {
            arguments: '{"cmd":"echo hello-responses"}',
            call_id: 'call_r1',
            id: 'fc_1',
            name: 'exec_command',
            status: 'completed',
            type: 'function_call',
          }
          writeSse(res, [
            { item: callItem, output_index: 0, type: 'response.output_item.done' },
            {
              response: {
                output: [callItem],
                status: 'completed',
                usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
              },
              type: 'response.completed',
            },
          ], ['data: [DONE]\n\n'])
          return
        }
        const msgItem = {
          content: [{ annotations: [], text: 'done-responses', type: 'output_text' }],
          id: 'msg_r2',
          role: 'assistant',
          status: 'completed',
          type: 'message',
        }
        writeSse(res, [
          { content_index: 0, delta: 'done-responses', item_id: 'msg_r2', output_index: 0, type: 'response.output_text.delta' },
          {
            response: {
              output: [msgItem],
              status: 'completed',
              usage: {
                input_tokens: 140,
                input_tokens_details: { cached_tokens: 100 },
                output_tokens: 6,
                total_tokens: 146,
              },
            },
            type: 'response.completed',
          },
        ], ['data: [DONE]\n\n'])
        return
      }

      if (idx === 0) {
        writeSse(res, [
          { message: { id: 'msg_m1', usage: { input_tokens: 100, output_tokens: 1 } }, type: 'message_start' },
          { content_block: { id: 'tool_m1', input: {}, name: 'exec_command', type: 'tool_use' }, index: 0, type: 'content_block_start' },
          { delta: { partial_json: '{"cmd":"echo hello-messages"}', type: 'input_json_delta' }, index: 0, type: 'content_block_delta' },
          { index: 0, type: 'content_block_stop' },
          { delta: { stop_reason: 'tool_use' }, type: 'message_delta', usage: { output_tokens: 15 } },
          { type: 'message_stop' },
        ])
        return
      }
      writeSse(res, [
        { message: { id: 'msg_m2', usage: { cache_read_input_tokens: 90, input_tokens: 50, output_tokens: 1 } }, type: 'message_start' },
        { content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' },
        { delta: { text: 'done-messages', type: 'text_delta' }, index: 0, type: 'content_block_delta' },
        { index: 0, type: 'content_block_stop' },
        { delta: { stop_reason: 'end_turn' }, type: 'message_delta', usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ])
    })

    const model = resolveModel({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      model: 'mock-model',
      protocol,
    })

    const result = await runAgent({
      cwd: dir,
      model,
      prompt: 'say hello',
      skills: [],
    })

    expect(result.stopReason).toBe('completed')
    expect(result.steps).toBe(2)
    expect(result.text).toBe(`done-${protocol}`)
    expect(server.requests).toHaveLength(2)

    const secondReqJson = JSON.stringify(server.requests[1])
    expect(secondReqJson).toContain(`hello-${protocol}`)

    expect(Object.keys(server.requests[0]).filter(key => /^max_(?:output_|completion_)?tokens$/.test(key)))
      .toEqual(protocol === 'messages' ? ['max_tokens'] : [])

    if (protocol === 'messages') {
      expect(server.requests[0].max_tokens).toBe(32_768)
      expect(server.requests[1].cache_control).toEqual({ type: 'ephemeral' })
      expect(server.requests[1].system).toMatchObject([{ cache_control: { type: 'ephemeral' }, type: 'text' }])
    }
  }

  it('runs exec_command tool loops on chat, responses, and messages protocols', async () => {
    await runProtocolToolLoop('chat')
    await runProtocolToolLoop('responses')
    await runProtocolToolLoop('messages')
  })

  it('retries a broken model stream without saving a duplicate assistant message', async () => {
    const dir = await makeTempDir()
    const server = await startServer(async (_body, idx, res) => {
      if (idx === 0) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial', role: 'assistant' }, finish_reason: null, index: 0 }] })}\n\n`)
        await sleep(20)
        res.destroy()
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: 'complete', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ], ['data: [DONE]\n\n'])
    })
    const sessionStore = await createSessionStore({
      cwd: dir,
      id: 'stream-retry',
      model: 'mock-model',
      protocol: 'chat',
      provider: 'custom',
      sessionsDir: dir,
    })
    const model = resolveModel({ baseURL: server.baseURL, model: 'mock-model', protocol: 'chat' })
    const events: AgentEvent[] = []

    const result = await runAgent({
      cwd: dir,
      model,
      onEvent: event => events.push(event),
      prompt: 'say hello',
      sessionStore,
      skills: [],
    })

    const records = (await readFile(sessionStore.filePath, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { message?: { role?: string }, type: string })
    expect(result.text).toBe('complete')
    expect(server.requests).toHaveLength(2)
    expect(events.filter(event => event.type === 'text.delta').map(event => event.delta)).toEqual(['partial', 'complete'])
    expect(events.filter(event => event.type === 'step.start')).toHaveLength(1)
    expect(records.filter(record => record.type === 'message' && record.message?.role === 'assistant')).toHaveLength(1)
  })

  it('splits parallel view_image tool results cleanly on chat while keeping canonical JSONL intact', async () => {
    const dir = await makeTempDir()
    await writeFile(join(dir, 'img.png'), PNG_BYTES)

    const server = await startServer((_body, idx, res) => {
      if (idx === 0) {
        writeSse(res, [
          {
            choices: [{
              delta: {
                role: 'assistant',
                tool_calls: [
                  { function: { arguments: '{"path":"img.png"}', name: 'view_image' }, id: 'call_img', index: 0, type: 'function' },
                  { function: { arguments: '{"cmd":"echo ok"}', name: 'exec_command' }, id: 'call_cmd', index: 1, type: 'function' },
                ],
              },
              finish_reason: null,
              index: 0,
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
        ], ['data: [DONE]\n\n'])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: 'saw image', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ], ['data: [DONE]\n\n'])
    })

    const sessionStore = await createSessionStore({
      cwd: dir,
      id: 'chat-img',
      model: 'deepseek-chat',
      protocol: 'chat',
      provider: 'deepseek',
      sessionsDir: dir,
    })

    const model = resolveModel({
      apiKey: 'k',
      baseURL: server.baseURL,
      model: 'deepseek-chat',
      protocol: 'chat',
    })

    const result = await runAgent({ cwd: dir, model, prompt: 'inspect image', sessionStore, skills: [] })
    expect(result.text).toBe('saw image')

    const secondMessages = server.requests[1].messages as { content: unknown, role: string }[]
    const roles = secondMessages.map(m => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user'])
    expect(secondMessages[3].content).toBe('(see attached image)')
    expect(secondMessages[5].content).toMatchObject([{ type: 'image_url' }])

    const reopened = await openSessionStore('chat-img', dir)
    const toolResultMsg = reopened.messages()[2]
    expect(toolResultMsg.role).toBe('user')
    expect(JSON.stringify(toolResultMsg)).toContain('data:image/png;base64,')
  })

  it('preserves byte-identical message prefixes across JSONL resume and detects cache misses', async () => {
    const dir = await makeTempDir()
    const cwd = join(dir, 'project', 'nested')
    const home = join(dir, 'config')
    await mkdir(cwd, { recursive: true })
    await mkdir(home)
    await writeFile(join(home, 'AGENTS.md'), 'global instruction')
    await writeFile(join(dir, 'AGENTS.md'), 'parent instruction')
    await writeFile(join(dir, 'project', 'AGENTS.md'), 'project instruction')
    await writeFile(join(cwd, 'AGENTS.md'), 'nested instruction')
    await writeFile(join(cwd, 'AGENTS.override.md'), 'ignored override')
    await writeFile(join(cwd, 'CLAUDE.md'), 'ignored claude')
    const server = await startServer((_body, idx, res) => {
      if (idx === 0) {
        writeSse(res, [
          { choices: [{ delta: { content: 'turn1-ok', role: 'assistant' }, finish_reason: null, index: 0 }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
            usage: { completion_tokens: 10, prompt_tokens: 2200, total_tokens: 2210 },
          },
        ], ['data: [DONE]\n\n'])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: 'turn2-ok', role: 'assistant' }, finish_reason: null, index: 0 }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { completion_tokens: 10, prompt_cache_hit_tokens: 200, prompt_tokens: 2500, total_tokens: 2510 },
        },
      ], ['data: [DONE]\n\n'])
    })

    const model = resolveModel({
      apiKey: 'k',
      baseURL: server.baseURL,
      model: 'deepseek-chat',
      protocol: 'chat',
    })

    const store = await createSessionStore({
      cwd,
      id: 'resume-prefix',
      model: 'deepseek-chat',
      protocol: 'chat',
      provider: 'deepseek',
      sessionsDir: dir,
    })

    await runAgent({ cwd, home, model, prompt: 'first', sessionStore: store, skills: [] })
    const firstTurnMessages = server.requests[0].messages as unknown[]
    const firstTurn = JSON.stringify(firstTurnMessages)
    expect(firstTurn.indexOf('global instruction')).toBeGreaterThan(-1)
    expect(firstTurn.indexOf('global instruction')).toBeLessThan(firstTurn.indexOf('parent instruction'))
    expect(firstTurn.indexOf('parent instruction')).toBeGreaterThan(-1)
    expect(firstTurn.indexOf('parent instruction')).toBeLessThan(firstTurn.indexOf('project instruction'))
    expect(firstTurn.indexOf('project instruction')).toBeLessThan(firstTurn.indexOf('nested instruction'))
    expect(firstTurn).not.toContain('ignored override')
    expect(firstTurn).not.toContain('ignored claude')
    await writeFile(join(cwd, 'AGENTS.md'), 'changed instruction')
    await writeFile(join(home, 'AGENTS.md'), 'changed global instruction')

    const resumedStore = await openSessionStore('resume-prefix', dir)
    const events: AgentEvent[] = []
    const resumedResult = await runAgent({
      cwd,
      home,
      model,
      onEvent: event => events.push(event),
      prompt: 'second',
      sessionStore: resumedStore,
      skills: [],
    })

    const secondTurnMessages = server.requests[1].messages as unknown[]
    expect(JSON.stringify(secondTurnMessages.slice(0, firstTurnMessages.length))).toBe(JSON.stringify(firstTurnMessages))
    expect(JSON.stringify(secondTurnMessages)).not.toContain('changed instruction')
    expect(JSON.stringify(secondTurnMessages)).not.toContain('changed global instruction')
    expect(resumedResult.cacheStats.misses).toHaveLength(1)
    expect(resumedResult.cacheStats.misses[0].missedTokens).toBe(2000)
    expect(events.some(event => event.type === 'cache.miss')).toBe(true)
  })

  it('breaks identical repeated tool loops without blocking empty write_stdin polls', async () => {
    const dir = await makeTempDir()
    const server = await startServer((_body, idx, res) => {
      writeSse(res, [
        {
          choices: [{
            delta: {
              role: 'assistant',
              tool_calls: [{
                function: { arguments: '{"cmd":"echo same"}', name: 'exec_command' },
                id: `call_${idx}`,
                index: 0,
                type: 'function',
              }],
            },
            finish_reason: null,
            index: 0,
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
      ], ['data: [DONE]\n\n'])
    })

    const model = resolveModel({
      apiKey: 'k',
      baseURL: server.baseURL,
      model: 'deepseek-chat',
      protocol: 'chat',
    })

    const result = await runAgent({
      cwd: dir,
      maxTurns: 10,
      model,
      prompt: 'loop test',
      skills: [],
    })

    expect(result.stopReason).toBe('loop_detected')
    expect(result.steps).toBe(3)
  })

  it('aborts in-flight requests cleanly via AbortSignal', async () => {
    const dir = await makeTempDir()
    const server = await startServer((_body, _idx, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"role":"assistant","content":"partial"},"finish_reason":null,"index":0}]}\n\n')
    })

    const model = resolveModel({
      apiKey: 'k',
      baseURL: server.baseURL,
      model: 'deepseek-chat',
      protocol: 'chat',
    })

    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(new Error('user aborted')), 100)

    try {
      await expect(runAgent({
        cwd: dir,
        model,
        prompt: 'hang',
        signal: controller.signal,
        skills: [],
      })).rejects.toThrow('user aborted')
    }
    finally {
      clearTimeout(abortTimer)
    }

    await sleep(20)
  })

  it('discloses visible skills on turn 0, activates explicit /skill and $skill references, and deduplicates across resume', async () => {
    const root = await makeTempDir()
    const userSkillsDir = join(root, 'user-skills')
    const projectDir = join(root, 'project')
    const projectSkillsDir = join(projectDir, '.agents', 'skills')
    const sessionsDir = join(root, 'sessions')

    await mkdir(join(userSkillsDir, 'alpha-helper'), { recursive: true })
    await writeFile(join(userSkillsDir, 'alpha-helper', 'SKILL.md'), '---\nname: alpha-helper\ndescription: Alpha instructions\n---\nAlpha body')

    await mkdir(join(projectSkillsDir, 'beta-manual'), { recursive: true })
    await writeFile(join(projectSkillsDir, 'beta-manual', 'SKILL.md'), '---\nname: beta-manual\ndescription: Manual only skill\ndisable-model-invocation: true\n---\nBeta body')

    await mkdir(sessionsDir, { recursive: true })

    const server = await startServer((_body, idx, res) => {
      writeSse(res, [
        { choices: [{ delta: { content: `turn-${idx + 1}`, role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      ], ['data: [DONE]\n\n'])
    })

    const model = resolveModel({
      apiKey: 'k',
      baseURL: server.baseURL,
      model: 'deepseek-chat',
      protocol: 'chat',
    })

    const store = await createSessionStore({
      cwd: projectDir,
      id: 'skills-session',
      model: 'deepseek-chat',
      protocol: 'chat',
      provider: 'deepseek',
      sessionsDir,
    })

    const skills = await discoverSkills({ cwd: projectDir, projectSkillsDir, userSkillsDir })
    await runAgent({
      cwd: projectDir,
      model,
      prompt: '/alpha-helper inspect repo',
      sessionStore: store,
      skills,
    })

    const firstTurnJson = JSON.stringify(server.requests[0])
    expect(firstTurnJson).toContain('<available_skills>')
    expect(firstTurnJson).toContain('<name>alpha-helper</name>')
    expect(firstTurnJson).not.toContain('<name>beta-manual</name>')
    expect(firstTurnJson).toContain('<skill_content name=\\"alpha-helper\\">')
    expect(firstTurnJson).toContain('Alpha body')

    const resumedStore = await openSessionStore('skills-session', sessionsDir)
    await runAgent({
      cwd: projectDir,
      model,
      prompt: 'also apply $alpha-helper and $beta-manual',
      sessionStore: resumedStore,
      skills,
    })

    const firstMsgs = server.requests[0].messages as unknown[]
    const secondMsgs = server.requests[1].messages as unknown[]
    expect(JSON.stringify(secondMsgs.slice(0, firstMsgs.length))).toBe(JSON.stringify(firstMsgs))

    const secondNewUserMsgJson = JSON.stringify(secondMsgs[firstMsgs.length + 1])
    expect(secondNewUserMsgJson).not.toContain('Alpha body')
    expect(secondNewUserMsgJson).toContain('<skill_content name=\\"beta-manual\\">')
    expect(secondNewUserMsgJson).toContain('Beta body')
  })

  it('applies model.contextTokens and model.supportsImageInput automatically in runAgent', async () => {
    const dir = await makeTempDir()
    const server = await startServer((_body, _idx, res) => {
      writeSse(res, [
        {
          choices: [{
            delta: {
              role: 'assistant',
              tool_calls: [{
                function: { arguments: '{"cmd":"echo hi"}', name: 'exec_command' },
                id: 'call_meta_1',
                index: 0,
                type: 'function',
              }],
            },
            finish_reason: null,
            index: 0,
          }],
        },
        {
          choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
          usage: { completion_tokens: 10, prompt_tokens: 1000, total_tokens: 1010 },
        },
      ], ['data: [DONE]\n\n'])
    })

    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { chat = "${server.baseURL}" }`,
      '[providers.local.models.text-only]',
      'context = 1100',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const result = await runAgent({
      cwd: dir,
      model: resolveModel({ apiKey: 'k', home: dir, model: 'text-only', provider: 'local' }),
      prompt: 'check metadata',
      skills: [],
    })

    expect(result.stopReason).toBe('context_limit')
    expect(result.stopReasonDetail).toContain('safety margin')
    expect(server.requests).toHaveLength(0)
  })

  it('replaces old history with one summary and rebuilds that context on resume', async () => {
    const dir = await makeTempDir()
    const skillDir = join(dir, '.agents', 'skills', 'compact-guide')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: compact-guide\ndescription: Keep this instruction\n---\nPreserve this exact compaction skill text.')
    const skills = await discoverSkills({ cwd: dir })
    const summary = [
      'Goal and unfinished requirements\nNone',
      'User corrections and active constraints\nNone',
      'Current state and changed files\nThe task is underway.',
      'Decisions and rejected approaches\nNone',
      'Checks run, results, and remaining verification\nNone',
      'Running commands and exact identifiers\nNone',
      'Next action and open questions\nContinue.',
      'References to recover omitted details\nNone',
    ].join('\n\n')
    const server = await startServer((body, idx, res) => {
      const messages = body.messages as { content?: string, role: string }[]
      const isSummary = JSON.stringify(messages).includes('Write a continuation summary')
      const text = idx === 0 ? 'x'.repeat(78_000) : idx === 2 ? 'y'.repeat(78_000) : isSummary ? summary : `answer-${idx}`
      writeSse(res, [
        { choices: [{ delta: { content: text, role: 'assistant' }, finish_reason: null, index: 0 }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { completion_tokens: 20, prompt_tokens: 5000, total_tokens: 5020 },
        },
      ], ['data: [DONE]\n\n'])
    })
    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { chat = "${server.baseURL}" }`,
      'headers = { x-opencode-session = "{session}" }',
      '[providers.local.models.compact-model]',
      'context = 40000',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const model = resolveModel({ apiKey: 'test-key', effort: 'high', home: dir, model: 'compact-model', provider: 'local' })
    const store = await createSessionStore({
      cwd: dir,
      id: 'compact-session',
      model: 'compact-model',
      protocol: 'chat',
      provider: 'local',
      sessionsDir: dir,
    })

    await runAgent({ cwd: dir, model, prompt: '/compact-guide initial request', sessionStore: store, skills })
    const result = await runAgent({ cwd: dir, model, prompt: 'continue the task', sessionStore: store, skills })
    const secondCompactionResult = await runAgent({ cwd: dir, model, prompt: 'continue after another long turn', sessionStore: store, skills })

    expect(result.stopReason).toBe('completed')
    expect(result.cacheStats.misses).toEqual([])
    expect(secondCompactionResult.stopReason).toBe('completed')
    expect(secondCompactionResult.cacheStats.misses).toEqual([])
    expect(server.requests).toHaveLength(5)
    const previousMessages = server.requests[0].messages as unknown[]
    const summaryMessages = server.requests[1].messages as unknown[]
    const compactedMessages = server.requests[2].messages as unknown[]
    expect(summaryMessages.slice(0, previousMessages.length)).toEqual(previousMessages)
    expect(server.requests[1].model).toBe(server.requests[0].model)
    expect(server.requests[1].tools).toEqual(server.requests[0].tools)
    expect(server.requests[1].tool_choice).toBe(server.requests[0].tool_choice)
    expect(server.requests[1].max_tokens).toBe(server.requests[0].max_tokens)
    expect(server.requests[1].reasoning_effort).toBe(server.requests[0].reasoning_effort)
    expect(JSON.stringify(server.requests[1])).toContain('Write a continuation summary')
    expect(JSON.stringify(compactedMessages)).not.toContain('x'.repeat(256))
    expect(JSON.stringify(compactedMessages)).toContain('The task is underway.')
    expect(JSON.stringify(compactedMessages)).toContain('Preserve this exact compaction skill text.')
    expect((compactedMessages as { role: string }[]).filter(message => message.role === 'user')).toHaveLength(2)
    const secondSummaryMessages = server.requests[3].messages as unknown[]
    const secondCompactedMessages = server.requests[4].messages as unknown[]
    expect(secondSummaryMessages.slice(0, compactedMessages.length)).toEqual(compactedMessages)
    expect(JSON.stringify(server.requests[3])).not.toContain('x'.repeat(256))
    expect(JSON.stringify(secondCompactedMessages)).not.toContain('x'.repeat(256))
    expect(JSON.stringify(secondCompactedMessages)).not.toContain('y'.repeat(256))
    expect(store.records().filter(record => record.type === 'compaction')).toHaveLength(2)
    expect(server.headers[0]['x-opencode-session']).toBe('compact-session')
    expect(server.headers[1]['x-opencode-session']).toBe('compact-session')
    expect(server.headers[2]['x-opencode-session']).toBe('compact-session')

    const resumed = await openSessionStore('compact-session', dir)
    const resumedResult = await runAgent({ cwd: dir, model, prompt: '/compact-guide resume here', sessionStore: resumed, skills })
    expect(resumedResult.stopReason).toBe('completed')
    expect(resumedResult.cacheStats.totalInputTokens).toBe(30_000)
    const resumedMessages = server.requests[5].messages as unknown[]
    expect(resumedMessages.slice(0, secondCompactedMessages.length)).toEqual(secondCompactedMessages)
    expect(JSON.stringify(resumedMessages)).not.toContain('x'.repeat(256))
    expect(JSON.stringify(resumedMessages)).not.toContain('y'.repeat(256))
    expect(JSON.stringify(resumedMessages).match(/Preserve this exact compaction skill text\./g)).toHaveLength(1)
  })

  it.each(['tool call', 'empty', 'missing section', 'truncated', 'post-compaction input'])('retries an invalid %s summary once without committing it', async (failure) => {
    const dir = await makeTempDir()
    const server = await startServer((_body, _idx, res) => {
      if (failure === 'tool call') {
        writeSse(res, [
          { choices: [{ delta: { role: 'assistant', tool_calls: [{ function: { arguments: '{}', name: 'exec_command' }, id: 'summary-tool', index: 0, type: 'function' }] }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 1000, total_tokens: 1010 } },
        ], ['data: [DONE]\n\n'])
        return
      }
      const headings = ['Goal and unfinished requirements', 'User corrections and active constraints', 'Current state and changed files', 'Decisions and rejected approaches', 'Checks run, results, and remaining verification', 'Running commands and exact identifiers', 'Next action and open questions', 'References to recover omitted details'].join('\n')
      const content = failure === 'empty'
        ? ''
        : failure === 'truncated'
          ? headings
          : failure === 'post-compaction input'
            ? `${headings}\n${'z'.repeat(55_000)}`
            : 'This summary has no required section headings.'
      writeSse(res, [
        { choices: [{ delta: { content, role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: failure === 'truncated' ? 'length' : 'stop', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 1000, total_tokens: 1010 } },
      ], ['data: [DONE]\n\n'])
    })
    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { chat = "${server.baseURL}" }`,
      '[providers.local.models.compact-model]',
      'context = 40000',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const model = resolveModel({ apiKey: 'test-key', home: dir, model: 'compact-model', provider: 'local' })
    const store = await createSessionStore({ cwd: dir, id: 'failed-compaction', model: 'compact-model', protocol: 'chat', provider: 'local', sessionsDir: dir })
    await store.appendMessage({ content: 'initial user request', role: 'user' })
    await store.appendMessage({ content: 'old work '.repeat(11_000), role: 'assistant' })

    const result = await runAgent({ cwd: dir, model, prompt: 'continue', sessionStore: store, skills: [] })

    expect(result.stopReason).toBe('context_limit')
    expect(result.stopReasonDetail).toContain('one correction')
    expect(result.cacheStats.totalInputTokens).toBe(2000)
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(server.requests[1])).toContain('Correction: the previous summary failed')
    expect(store.compaction()).toBeUndefined()
    expect(store.records().some(record => record.type === 'compaction')).toBe(false)
    const reopened = await openSessionStore('failed-compaction', dir)
    expect(reopened.cacheStats.snapshot().totalInputTokens).toBe(2000)
    expect(reopened.usageBaseline()).toBeUndefined()
  })

  it('does not retry or commit a cancelled summary request', async () => {
    const dir = await makeTempDir()
    const server = await startServer(async (_body, _idx, _res, req) => {
      await new Promise<void>(resolve => req.on('close', resolve))
    })
    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { chat = "${server.baseURL}" }`,
      '[providers.local.models.compact-model]',
      'context = 40000',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const model = resolveModel({ apiKey: 'test-key', home: dir, model: 'compact-model', provider: 'local' })
    const store = await createSessionStore({ cwd: dir, id: 'cancelled-compaction', model: 'compact-model', protocol: 'chat', provider: 'local', sessionsDir: dir })
    await store.appendMessage({ content: 'initial user request', role: 'user' })
    await store.appendMessage({ content: 'old work '.repeat(11_000), role: 'assistant' })
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(new Error('user aborted')), 100)

    try {
      await expect(runAgent({ cwd: dir, model, prompt: 'continue', sessionStore: store, signal: controller.signal, skills: [] })).rejects.toThrow('user aborted')
    }
    finally {
      clearTimeout(abortTimer)
    }

    expect(server.requests).toHaveLength(1)
    expect(store.compaction()).toBeUndefined()
  })

  it('keeps a tool call, its result, and reasoning together in the retained suffix', async () => {
    const dir = await makeTempDir()
    const summary = [
      'Goal and unfinished requirements',
      'User corrections and active constraints',
      'Current state and changed files',
      'Decisions and rejected approaches',
      'Checks run, results, and remaining verification',
      'Running commands and exact identifiers',
      'Next action and open questions',
      'References to recover omitted details',
    ].join('\n')
    const server = await startServer((body, _idx, res) => {
      const isSummary = JSON.stringify(body.messages).includes('Write a continuation summary')
      const text = isSummary ? summary : 'done'
      writeSse(res, [
        { choices: [{ delta: { content: text, role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 1000, total_tokens: 1010 } },
      ], ['data: [DONE]\n\n'])
    })
    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { chat = "${server.baseURL}" }`,
      '[providers.local.models.compact-model]',
      'context = 40000',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const model = resolveModel({ apiKey: 'test-key', home: dir, model: 'compact-model', provider: 'local' })
    const store = await createSessionStore({ cwd: dir, id: 'tool-unit-compaction', model: 'compact-model', protocol: 'chat', provider: 'local', sessionsDir: dir })
    await store.appendMessage({ content: 'initial request', role: 'user' })
    await store.appendMessage({ content: 'old work '.repeat(11_000), role: 'assistant' })
    await store.appendMessage({
      content: [
        { content: [{ text: 'Reasoning stays with this call.', type: 'text' }], type: 'reasoning' },
        { arguments: '{}', callId: 'preserved-call', id: 'preserved-call', name: 'exec_command', type: 'tool-call' },
      ],
      role: 'assistant',
    })
    await store.appendMessage({
      content: [{ callId: 'preserved-call', output: 'The matching tool result stays with the call.', type: 'tool-result' }],
      role: 'user',
    })

    await runAgent({ cwd: dir, model, prompt: 'continue', sessionStore: store, skills: [] })

    expect(server.requests).toHaveLength(2)
    const compactedRequest = JSON.stringify(server.requests[1])
    expect(compactedRequest).toContain('Reasoning stays with this call.')
    expect(compactedRequest).toContain('preserved-call')
    expect(compactedRequest).toContain('The matching tool result stays with the call.')
  })

  it.each(['chat', 'messages'] as const)('judges whether the summary request fits from the reported usage, not the byte estimate (%s)', async (protocol) => {
    const dir = await makeTempDir()
    const summary = [
      'Goal and unfinished requirements',
      'User corrections and active constraints',
      'Current state and changed files',
      'Decisions and rejected approaches',
      'Checks run, results, and remaining verification',
      'Running commands and exact identifiers',
      'Next action and open questions',
      'References to recover omitted details',
    ].join('\n')
    const server = await startServer((body, _idx, res) => {
      const text = JSON.stringify(body.messages).includes('Write a continuation summary') ? summary : 'done'
      if (protocol === 'messages') {
        writeSse(res, [
          { message: { id: 'msg', usage: { input_tokens: 32000, output_tokens: 1 } }, type: 'message_start' },
          { content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' },
          { delta: { text, type: 'text_delta' }, index: 0, type: 'content_block_delta' },
          { index: 0, type: 'content_block_stop' },
          { delta: { stop_reason: 'end_turn' }, type: 'message_delta', usage: { output_tokens: 10 } },
          { type: 'message_stop' },
        ])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: text, role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 32000, total_tokens: 32010 } },
      ], ['data: [DONE]\n\n'])
    })
    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { ${protocol} = "${server.baseURL}" }`,
      '[providers.local.models.compact-model]',
      'context = 40000',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const model = resolveModel({ apiKey: 'test-key', home: dir, model: 'compact-model', provider: 'local' })
    const store = await createSessionStore({ cwd: dir, id: 'usage-fit', model: 'compact-model', protocol, provider: 'local', sessionsDir: dir })
    await store.appendMessage({ content: 'start', role: 'user' })
    await store.appendMessage({ content: 'z'.repeat(111_000), role: 'assistant' })
    await store.appendMessage({ content: 'more', role: 'user' })
    await store.appendMessage({ content: 'ok', role: 'assistant' })
    await store.appendUsage({ model: 'compact-model', stepNumber: 0, usage: { inputTokens: 31_500, outputTokens: 1, totalTokens: 31_501 } })

    const result = await runAgent({ cwd: dir, model, prompt: 'continue', sessionStore: store, skills: [] })

    expect(result.stopReason).toBe('completed')
    expect(server.requests).toHaveLength(2)
    expect(JSON.stringify(server.requests[0])).toContain('Write a continuation summary')
    expect(JSON.stringify(server.requests[1])).not.toContain('z'.repeat(256))
    if (protocol === 'messages') {
      const [combined] = server.requests[1].messages as { content: { cache_control?: unknown, text?: string }[] }[]
      expect(combined.content.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } })
      expect(combined.content.at(-1)?.text).toContain('Historical work state summary')
    }
  })

  it('keeps exec sessions, step counts, and loop detection across compaction', async () => {
    const dir = await makeTempDir()
    let execSessionId: string | undefined
    const summary = [
      'Goal and unfinished requirements',
      'User corrections and active constraints',
      'Current state and changed files',
      'Decisions and rejected approaches',
      'Checks run, results, and remaining verification',
      'Running commands and exact identifiers',
      'Next action and open questions',
      'References to recover omitted details',
    ].join('\n')
    const server = await startServer((body, idx, res) => {
      if (idx === 1) {
        const sessionMatch = /Process running with session ID (\d+)/.exec(JSON.stringify(body.messages))
        execSessionId = sessionMatch?.[1]
        writeSse(res, [
          { choices: [{ delta: { content: summary, role: 'assistant' }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 70000, total_tokens: 70010 } },
        ], ['data: [DONE]\n\n'])
        return
      }
      if (idx === 0) {
        writeSse(res, [
          { choices: [{ delta: { role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify({ cmd: 'python3 -u -c \'import time; print("x" * 65000, flush=True); time.sleep(60)\'', yield_time_ms: 250 }), name: 'exec_command' }, id: 'start-long-command', index: 0, type: 'function' }] }, finish_reason: null, index: 0 }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 70000, total_tokens: 70010 } },
        ], ['data: [DONE]\n\n'])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify({ chars: '\n', session_id: Number.parseInt(execSessionId ?? '0', 10), yield_time_ms: 250 }), name: 'write_stdin' }, id: `poll-${idx}`, index: 0, type: 'function' }] }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }], usage: { completion_tokens: 10, prompt_tokens: 30000, total_tokens: 30010 } },
      ], ['data: [DONE]\n\n'])
    })
    await writeFile(join(dir, 'config.toml'), [
      '[providers.local]',
      `base_url = { chat = "${server.baseURL}" }`,
      '[providers.local.models.compact-model]',
      'context = 100000',
      'image = false',
      'max_output = 100',
    ].join('\n'))
    const model = resolveModel({ apiKey: 'test-key', home: dir, model: 'compact-model', provider: 'local' })
    const store = await createSessionStore({ cwd: dir, id: 'live-exec-compaction', model: 'compact-model', protocol: 'chat', provider: 'local', sessionsDir: dir })
    await store.appendMessage({ content: 'initial request', role: 'user' })
    await store.appendMessage({ content: 'old work '.repeat(23_000), role: 'assistant' })

    const result = await runAgent({ cwd: dir, maxTurns: 10, model, prompt: 'continue', sessionStore: store, skills: [] })

    expect(execSessionId).toMatch(/^\d+$/)
    expect(result.stopReason).toBe('loop_detected')
    expect(result.steps).toBe(4)
    expect(server.requests).toHaveLength(5)
    expect(JSON.stringify(server.requests[3])).not.toContain('Unknown process session ID')
    expect(JSON.stringify(server.requests[1])).toContain('old work old work')
    expect(JSON.stringify(server.requests[2])).not.toContain('old work old work')
    expect(store.records().filter(record => record.type === 'compaction')).toHaveLength(1)
  })
})
