import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeTool } from '@xsai/text'
import { afterEach, describe, expect, it } from 'vitest'

import { createExecManager, createTools, detectImageMimeType } from '../src/tools'

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])
const JPEG_BYTES = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
const GIF_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])

describe('detectImageMimeType', () => {
  it('detects PNG, JPEG, GIF, and WebP signatures', () => {
    expect(detectImageMimeType(PNG_BYTES)).toBe('image/png')
    expect(detectImageMimeType(JPEG_BYTES)).toBe('image/jpeg')
    expect(detectImageMimeType(GIF_BYTES)).toBe('image/gif')
    expect(detectImageMimeType(WEBP_BYTES)).toBe('image/webp')
    expect(detectImageMimeType(Buffer.from('plain text'))).toBeUndefined()
  })
})

describe('createTools', () => {
  const tempDirs: string[] = []
  const managers: ReturnType<typeof createExecManager>[] = []

  afterEach(async () => {
    while (managers.length > 0)
      managers.pop()?.dispose()
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir != null && dir !== '')
        await rm(dir, { force: true, recursive: true })
    }
  })

  it('executes exec_command and write_stdin through @xsai/text executeTool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-tools-'))
    tempDirs.push(dir)
    const execManager = createExecManager({ defaultCwd: dir })
    managers.push(execManager)
    const tools = createTools({ cwd: dir, execManager })

    const execResult = await executeTool({
      arguments: JSON.stringify({
        cmd: 'node -e "process.stdout.write(require(\'fs\').readFileSync(0, \'utf8\').toUpperCase())"',
        stdin: 'hello fwt',
      }),
      callId: 'call-1',
      id: 'tool-1',
      name: 'exec_command',
      type: 'tool-call',
    }, { tools })

    expect(execResult.isError).toBeUndefined()
    expect(execResult.output).toContain('HELLO FWT')

    const startInteractive = await executeTool({
      arguments: JSON.stringify({
        cmd: 'read line; echo "ack:$line"',
        yield_time_ms: 250,
      }),
      callId: 'call-2',
      id: 'tool-2',
      name: 'exec_command',
      type: 'tool-call',
    }, { tools })

    const match = /session ID (\d+)/.exec(String(startInteractive.output))
    expect(match).not.toBeNull()

    const writeResult = await executeTool({
      arguments: JSON.stringify({
        chars: 'ok\n',
        session_id: Number.parseInt(match![1], 10),
        yield_time_ms: 500,
      }),
      callId: 'call-3',
      id: 'tool-3',
      name: 'write_stdin',
      type: 'tool-call',
    }, { tools })

    expect(writeResult.isError).toBeUndefined()
    expect(writeResult.output).toContain('ack:ok')
  })

  it('returns ImagePart data URLs from view_image and rejects non-images', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-img-'))
    tempDirs.push(dir)
    const imgPath = join(dir, 'sample.bin')
    const txtPath = join(dir, 'note.txt')
    await writeFile(imgPath, PNG_BYTES)
    await writeFile(txtPath, 'not an image')

    const execManager = createExecManager({ defaultCwd: dir })
    managers.push(execManager)
    const tools = createTools({ cwd: dir, execManager })

    const okResult = await executeTool({
      arguments: JSON.stringify({ detail: 'high', path: 'sample.bin' }),
      callId: 'call-img-1',
      id: 'tool-img-1',
      name: 'view_image',
      type: 'tool-call',
    }, { tools })

    expect(okResult.isError).toBeUndefined()
    expect(okResult.output).toEqual([{
      data: `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`,
      detail: 'high',
      type: 'image',
    }])

    const errResult = await executeTool({
      arguments: JSON.stringify({ path: 'note.txt' }),
      callId: 'call-img-2',
      id: 'tool-img-2',
      name: 'view_image',
      type: 'tool-call',
    }, { tools })

    expect(errResult.isError).toBe(true)
    expect(errResult.output).toContain('Unsupported or unrecognized image format')
  })

  it('omits view_image when supportsImageInput is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-no-img-'))
    tempDirs.push(dir)
    const execManager = createExecManager({ defaultCwd: dir })
    managers.push(execManager)
    const tools = createTools({ cwd: dir, execManager, supportsImageInput: false })

    expect(tools.map(t => t.name)).toEqual(['exec_command', 'write_stdin'])
  })
})
