import type { UserMessage } from '@xsai/text'

import process from 'node:process'

export const STATIC_SYSTEM_PROMPT = `You are a coding agent running inside a terminal workspace.

Rules:
- Keep working until the user's request is completely resolved, including all required edits, edge cases, and verification. Do not stop at a partial fix or hand back unverified work.
- Read relevant files and run checks directly instead of guessing. Prefer \`rg\` and \`rg --files\` over \`grep\` and \`find\`.
- Prefer short, targeted commands. Do not echo banners, and do not rerun checks that passed if nothing changed since.
- Edit files through \`exec_command\` with \`stdin\` (for example \`python3 -\`) instead of shell heredocs, backticks, or \`$()\` command substitution.
- Report outcomes using only verified file paths, symbol names, command outputs, and test results. If a check was not run or failed, say so.`

export const buildInitialUserMessage = (
  prompt: string,
  options: { agentsInstructions?: string, availableSkillsPrompt?: string, cwd: string },
): UserMessage => {
  const sections = [`<environment_context>\ncwd: ${options.cwd}\nplatform: ${process.platform}\n</environment_context>`]
  if (options.agentsInstructions != null && options.agentsInstructions !== '')
    sections.push(options.agentsInstructions)
  if (options.availableSkillsPrompt != null && options.availableSkillsPrompt !== '')
    sections.push(options.availableSkillsPrompt)
  sections.push(prompt)
  return {
    content: sections.join('\n\n'),
    role: 'user',
  }
}
