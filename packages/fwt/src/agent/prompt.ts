import type { ImagePart, Message, TextPart, ToolResultPartContent } from '@xsai/text'

import type { WireProtocol } from '../providers'

import process from 'node:process'

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { fwtDirs } from '../home'

export const STATIC_SYSTEM_PROMPT = `You are a coding agent running inside a terminal workspace.

Rules:
- Keep working until the user's request is completely resolved, including all required edits, edge cases, and verification. Do not stop at a partial fix or hand back unverified work.
- Read relevant files and run checks directly instead of guessing. Prefer \`rg\` and \`rg --files\` over \`grep\` and \`find\`.
- Prefer short, targeted commands. Do not echo banners, and do not rerun checks that passed if nothing changed since.
- Edit files through \`exec_command\` with \`stdin\` (for example \`python3 -\`) instead of shell heredocs, backticks, or \`$()\` command substitution.
- Report outcomes using only verified file paths, symbol names, command outputs, and test results. If a check was not run or failed, say so.`

const readAgentsInstructions = async (cwd: string, home?: string): Promise<string[]> => {
  const directories: string[] = []
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    directories.unshift(directory)
    if (dirname(directory) === directory)
      break
  }
  const instructions: string[] = []
  for (const dir of new Set([fwtDirs(home).config, ...directories])) {
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
  return instructions
}

export const buildInitialUserMessage = async (
  prompt: string,
  options: { availableSkillsPrompt: string, cwd: string, home?: string },
): Promise<{ content: string, role: 'user' }> => ({
  content: [
    `<environment_context>\ncwd: ${options.cwd}\nplatform: ${process.platform}\n</environment_context>`,
    ...await readAgentsInstructions(options.cwd, options.home),
    options.availableSkillsPrompt,
    prompt,
  ].filter(section => section !== '').join('\n\n'),
  role: 'user',
})

const splitToolResultImages = (message: Message): Message => {
  if (message.role !== 'user' || typeof message.content === 'string')
    return message
  const images: ImagePart[] = []
  const content = message.content.map((part) => {
    if (part.type !== 'tool-result' || !Array.isArray(part.output) || !part.output.some(item => item.type === 'image'))
      return part
    const texts: ToolResultPartContent[] = part.output.filter(item => item.type !== 'image')
    images.push(...part.output.filter(item => item.type === 'image'))
    return { ...part, output: texts.length > 0 ? texts : '(see attached image)' }
  })
  return images.length === 0 ? message : { ...message, content: [...content, ...images] }
}

const withCacheControl = (part: TextPart): TextPart => ({
  ...part,
  providerMetadata: {
    ...part.providerMetadata,
    messages: { ...part.providerMetadata?.messages, cacheControl: { type: 'ephemeral' } },
  },
})

const hasText = (message: Message): boolean =>
  (message.role === 'user' || message.role === 'assistant')
  && (typeof message.content === 'string' || message.content.some(part => part.type === 'text'))

const markLastText = (message: Message): Message => {
  if (typeof message.content === 'string')
    return { ...message, content: [withCacheControl({ text: message.content, type: 'text' })] }
  const index = message.content.findLastIndex(part => part.type === 'text')
  return { ...message, content: message.content.with(index, withCacheControl(message.content[index] as TextPart)) } as Message
}

export const toWireRequest = (
  messages: readonly Message[],
  protocol: WireProtocol,
  compacted: boolean,
): { input: Message[], instructions?: string } => {
  if (protocol === 'chat')
    return { input: messages.map(splitToolResultImages), instructions: STATIC_SYSTEM_PROMPT }
  if (protocol === 'responses')
    return { input: [...messages], instructions: STATIC_SYSTEM_PROMPT }
  const input = [...messages]
  const lastText = input.findLastIndex(hasText)
  if (lastText !== -1)
    input[lastText] = markLastText(input[lastText])
  if (compacted)
    input[0] = markLastText(input[0])
  return {
    input: [{ content: [withCacheControl({ text: STATIC_SYSTEM_PROMPT, type: 'text' })], role: 'system' }, ...input],
    instructions: undefined,
  }
}
