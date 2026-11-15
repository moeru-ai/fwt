import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { AgentEvent } from '../src/agent'
import type { WireProtocol } from '../src/providers'

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sleep } from '@moeru/std'
import { afterEach, describe, expect, it } from 'vitest'

import { discoverSkills, runAgent, STATIC_SYSTEM_PROMPT } from '../src/agent'
import { resolveModel } from '../src/providers'
import { createSessionStore, openSessionStore } from '../src/session'

interface MockServer {
  baseURL: string
  close: () => Promise<void>
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
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Uint8Array[] = []
      for await (const chunk of req)
        chunks.push(chunk as Uint8Array)
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const parsed = rawBody === '' ? {} : JSON.parse(rawBody) as Record<string, unknown>
      requests.push(parsed)
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

  it('injects a one-time soft context_window_reminder at 85% maxContextTokens while preserving prefix immutability', async () => {
    const dir = await makeTempDir()
    const server = await startServer((_body, idx, res) => {
      if (idx === 0) {
        writeSse(res, [
          {
            choices: [{
              delta: {
                role: 'assistant',
                tool_calls: [{
                  function: { arguments: '{"cmd":"echo step1"}', name: 'exec_command' },
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
            usage: { completion_tokens: 10, prompt_tokens: 850, total_tokens: 860 },
          },
        ], ['data: [DONE]\n\n'])
        return
      }
      if (idx === 1) {
        writeSse(res, [
          {
            choices: [{
              delta: {
                role: 'assistant',
                tool_calls: [{
                  function: { arguments: '{"cmd":"echo step2"}', name: 'exec_command' },
                  id: 'call_2',
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
            usage: { completion_tokens: 10, prompt_tokens: 900, total_tokens: 910 },
          },
        ], ['data: [DONE]\n\n'])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: 'wrapped-up', role: 'assistant' }, finish_reason: null, index: 0 }] },
        {
          choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
          usage: { completion_tokens: 8, prompt_tokens: 920, total_tokens: 928 },
        },
      ], ['data: [DONE]\n\n'])
    })

    const store = await createSessionStore({
      cwd: dir,
      id: 'ctx-reminder',
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

    const result = await runAgent({
      cwd: dir,
      model: { ...model, contextTokens: 1100, maxOutputTokens: 100 },
      prompt: 'finish cleanly',
      sessionStore: store,
      skills: [],
    })

    expect(result.stopReason).toBe('completed')
    expect(result.text).toBe('wrapped-up')
    expect(STATIC_SYSTEM_PROMPT).toContain('rg --files')

    const req1Msgs = server.requests[1].messages as unknown[]
    const req2Msgs = server.requests[2].messages as unknown[]
    expect(JSON.stringify(req2Msgs.slice(0, req1Msgs.length))).toBe(JSON.stringify(req1Msgs))

    const req2Json = JSON.stringify(req2Msgs)
    expect(req2Json.match(/<context_window_reminder>/g)).toHaveLength(1)

    const reopened = await openSessionStore('ctx-reminder', dir)
    expect(JSON.stringify(reopened.messages()).match(/<context_window_reminder>/g)).toHaveLength(1)
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
    const server = await startServer((_body, idx, res) => {
      if (idx === 0) {
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
            usage: { completion_tokens: 10, prompt_tokens: 850, total_tokens: 860 },
          },
        ], ['data: [DONE]\n\n'])
        return
      }
      writeSse(res, [
        { choices: [{ delta: { content: 'meta-done', role: 'assistant' }, finish_reason: null, index: 0 }] },
        { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
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

    expect(result.text).toBe('meta-done')
    const sentTools = (server.requests[0].tools as { function: { name: string } }[]).map(t => t.function.name)
    expect(sentTools).toEqual(['exec_command', 'write_stdin'])
    expect(JSON.stringify(server.requests[1].messages)).toContain('<context_window_reminder>')
  })
})
