import type { ExecutableTool, ImagePart, ToolResultPartContent } from '@xsai/text'

import type { ExecManager } from './exec'

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { encodeBase64 } from '@moeru/std'
import { toStandardJsonSchema } from '@valibot/to-json-schema'
import { tool } from '@xsai/text'

import * as v from 'valibot'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024

interface CreateToolsOptions {
  cwd: string
  execManager: ExecManager
  supportsImageInput?: boolean
}

const matchesBytes = (bytes: Uint8Array, offset: number, signature: readonly number[]): boolean => {
  if (bytes.length < offset + signature.length)
    return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i])
      return false
  }
  return true
}

export const detectImageMimeType = (bytes: Uint8Array): string | undefined => {
  if (matchesBytes(bytes, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    return 'image/png'
  if (matchesBytes(bytes, 0, [0xFF, 0xD8, 0xFF]))
    return 'image/jpeg'
  if (
    matchesBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || matchesBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif'
  }
  if (
    matchesBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && matchesBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp'
  }
  return undefined
}

export const readImageFile = async (path: string, cwd: string, signal?: AbortSignal): Promise<ImagePart> => {
  const resolvedPath = resolve(cwd, path)
  const info = await stat(resolvedPath)
  if (!info.isFile())
    throw new Error(`Path is not a file: ${path}`)
  if (info.size > MAX_IMAGE_BYTES)
    throw new Error(`Image exceeds 20 MiB limit: ${path}`)

  const bytes = await readFile(resolvedPath, { signal })
  const mimeType = detectImageMimeType(bytes)
  if (mimeType == null)
    throw new Error(`Unsupported or unrecognized image format: ${path}`)
  return { data: `data:${mimeType};base64,${encodeBase64(bytes)}`, type: 'image' }
}

const maxOutputTokensSchema = v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.description('Maximum tokens of output to return (default 10000).')))

const execCommandInputSchema = toStandardJsonSchema(v.object({
  cmd: v.pipe(v.string(), v.description('Shell command to execute.')),
  max_output_tokens: maxOutputTokensSchema,
  stdin: v.optional(v.pipe(v.string(), v.description('Text to write to stdin before closing it with EOF. Use for python3 - scripts or file edits without heredocs.'))),
  workdir: v.optional(v.pipe(v.string(), v.description('Working directory for the command, absolute or relative to the workspace root.'))),
  yield_time_ms: v.optional(v.pipe(v.number(), v.integer(), v.description('Milliseconds to wait before yielding output from a running command (250 to 30000, default 10000).'))),
}))

const writeStdinInputSchema = toStandardJsonSchema(v.object({
  chars: v.optional(v.pipe(v.string(), v.description('Characters to write to stdin. Leave empty to poll for output.'))),
  max_output_tokens: maxOutputTokensSchema,
  session_id: v.pipe(v.number(), v.integer(), v.description('Session ID returned by a running exec_command call.')),
  yield_time_ms: v.optional(v.pipe(v.number(), v.integer(), v.description('Milliseconds to wait for output (default 250 with chars, 5000 when polling).'))),
}))

const viewImageInputSchema = toStandardJsonSchema(v.object({
  detail: v.optional(v.pipe(v.picklist(['auto', 'low', 'high']), v.description('Optional vision detail hint.'))),
  path: v.pipe(v.string(), v.description('Path to a PNG, JPEG, GIF, or WebP image file.')),
}))

export const createTools = ({ cwd, execManager, supportsImageInput = true }: CreateToolsOptions): ExecutableTool[] => {
  const execCommand = tool({
    description: 'Run a shell command in the workspace. Pass stdin to write it and close stdin with EOF right away (use this for python3 - and file contents); omit stdin to keep the pipe open for write_stdin.',
    execute: async (input, options) => {
      const result = await execManager.execCommand({
        cmd: input.cmd,
        maxOutputTokens: input.max_output_tokens,
        stdin: input.stdin,
        workdir: input.workdir,
        yieldTimeMs: input.yield_time_ms,
      }, options?.signal)
      return result.text
    },
    inputSchema: execCommandInputSchema,
    name: 'exec_command',
  })

  const writeStdin = tool({
    description: 'Write characters to an active exec_command session or poll it for new output.',
    execute: async (input, options) => {
      const result = await execManager.writeStdin({
        chars: input.chars,
        maxOutputTokens: input.max_output_tokens,
        sessionId: input.session_id,
        yieldTimeMs: input.yield_time_ms,
      }, options?.signal)
      return result.text
    },
    inputSchema: writeStdinInputSchema,
    name: 'write_stdin',
  })

  if (!supportsImageInput)
    return [execCommand, writeStdin]

  const viewImage = tool({
    description: 'Read a local PNG, JPEG, GIF, or WebP image file into the conversation context.',
    execute: async (input, options) => {
      options?.signal?.throwIfAborted()
      const image = await readImageFile(input.path, cwd, options?.signal)
      return [input.detail ? { ...image, detail: input.detail } : image] satisfies ToolResultPartContent[]
    },
    inputSchema: viewImageInputSchema,
    name: 'view_image',
  })

  return [execCommand, writeStdin, viewImage]
}
