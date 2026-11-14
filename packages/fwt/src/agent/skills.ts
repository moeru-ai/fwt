import type { Dirent } from 'node:fs'

import type { Message } from '@xsai/text'

import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'

const MAX_SKILL_SCAN_DEPTH = 5
const MAX_SKILL_RESOURCES = 50

export interface Skill {
  baseDir: string
  description: string
  disableModelInvocation: boolean
  filePath: string
  name: string
  source: 'project' | 'user'
}

interface DiscoverSkillsOptions {
  cwd: string
  projectSkillsDir?: string
  userSkillsDir?: string
}

interface ParsedSkillDocument {
  body: string
  description?: string
  disableModelInvocation: boolean
  hasValidFrontmatter: boolean
  name?: string
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')

const unescapeXml = (value: string): string =>
  value
    .replaceAll('&apos;', '\'')
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')

const unquoteYamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replaceAll('\\n', '\n')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\''))
    return trimmed.slice(1, -1).replaceAll('\'\'', '\'')
  return trimmed
}

const dedentBlockLines = (lines: readonly string[]): string[] => {
  let minIndent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    if (line.trim() === '')
      continue
    const indent = line.length - line.trimStart().length
    if (indent < minIndent)
      minIndent = indent
  }
  if (!Number.isFinite(minIndent) || minIndent === 0)
    return [...lines]
  return lines.map(line => line.trim() === '' ? '' : line.slice(minIndent))
}

const readBlockScalar = (
  lines: readonly string[],
  startIndex: number,
  indicator: string,
): { nextIndex: number, value: string } => {
  const collected: string[] = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('\t'))
      break
    collected.push(line)
    index += 1
  }
  const normalizedLines = dedentBlockLines(collected)
  const joined = indicator.startsWith('>')
    ? normalizedLines.map(line => line.trim()).filter(Boolean).join(' ')
    : normalizedLines.join('\n').trim()
  return { nextIndex: index, value: joined }
}

const parseFrontmatterFields = (yamlText: string): Record<string, string> => {
  const fields: Record<string, string> = {}
  const lines = yamlText.split('\n')
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || line.startsWith(' ') || line.startsWith('\t')) {
      index += 1
      continue
    }

    const colonIndex = line.indexOf(':')
    if (colonIndex <= 0) {
      index += 1
      continue
    }

    const key = line.slice(0, colonIndex).trim()
    const rawValue = line.slice(colonIndex + 1).trim()

    if (rawValue === '|' || rawValue === '|-' || rawValue === '>' || rawValue === '>-') {
      const block = readBlockScalar(lines, index + 1, rawValue)
      fields[key] = block.value
      index = block.nextIndex
      continue
    }

    fields[key] = unquoteYamlScalar(rawValue)
    index += 1
  }

  return fields
}

export const parseSkillDocument = (content: string): ParsedSkillDocument => {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')

  if (!normalized.startsWith('---\n')) {
    return {
      body: normalized.trim(),
      disableModelInvocation: false,
      hasValidFrontmatter: false,
    }
  }

  const closingOffset = normalized.indexOf('\n---', 3)
  if (closingOffset === -1) {
    return {
      body: normalized.trim(),
      disableModelInvocation: false,
      hasValidFrontmatter: false,
    }
  }

  const afterClose = normalized.slice(closingOffset + 4)
  if (afterClose !== '' && !afterClose.startsWith('\n')) {
    return {
      body: normalized.trim(),
      disableModelInvocation: false,
      hasValidFrontmatter: false,
    }
  }

  const yamlText = normalized.slice(4, closingOffset)
  const fields = parseFrontmatterFields(yamlText)
  const rawName = fields.name?.trim()
  const rawDescription = fields.description?.trim()

  return {
    body: afterClose.trim(),
    description: rawDescription != null && rawDescription !== '' ? rawDescription : undefined,
    disableModelInvocation: fields['disable-model-invocation']?.toLowerCase() === 'true',
    hasValidFrontmatter: true,
    name: rawName != null && rawName !== '' ? rawName : undefined,
  }
}

const readSortedEntries = async (dir: string) => {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter(entry => !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name))
  }
  catch {
    return []
  }
}

const isEntryKind = async (path: string, entry: Dirent, kind: 'directory' | 'file'): Promise<boolean> => {
  if (!entry.isSymbolicLink())
    return kind === 'file' ? entry.isFile() : entry.isDirectory()
  const info = await stat(path).catch(() => undefined)
  return kind === 'file' ? info?.isFile() === true : info?.isDirectory() === true
}

const loadSkill = async (dir: string, entry: Dirent, source: Skill['source']): Promise<Skill | undefined> => {
  const filePath = join(dir, 'SKILL.md')
  if (!await isEntryKind(filePath, entry, 'file'))
    return undefined
  const parsed = parseSkillDocument(await readFile(filePath, 'utf8'))
  if (!parsed.hasValidFrontmatter || parsed.description == null)
    return undefined
  return {
    baseDir: dir,
    description: parsed.description,
    disableModelInvocation: parsed.disableModelInvocation,
    filePath,
    name: parsed.name ?? basename(dir),
    source,
  }
}

const scanSkillsRoot = async (rootDir: string, source: Skill['source']): Promise<Skill[]> => {
  const skills: Skill[] = []
  const queue = [{ depth: 0, dir: rootDir }]
  for (let current = queue.shift(); current != null; current = queue.shift()) {
    const entries = await readSortedEntries(current.dir)
    const skillEntry = entries.find(entry => entry.name === 'SKILL.md')
    if (skillEntry != null) {
      const skill = await loadSkill(current.dir, skillEntry, source)
      if (skill != null)
        skills.push(skill)
      continue
    }
    if (current.depth >= MAX_SKILL_SCAN_DEPTH)
      continue
    for (const entry of entries) {
      const child = join(current.dir, entry.name)
      if (await isEntryKind(child, entry, 'directory'))
        queue.push({ depth: current.depth + 1, dir: child })
    }
  }
  return skills
}

export const discoverSkills = async (options: DiscoverSkillsOptions): Promise<Skill[]> => {
  const [userSkills, projectSkills] = await Promise.all([
    scanSkillsRoot(options.userSkillsDir ?? join(homedir(), '.agents', 'skills'), 'user'),
    scanSkillsRoot(options.projectSkillsDir ?? join(options.cwd, '.agents', 'skills'), 'project'),
  ])
  return [...new Map([...userSkills, ...projectSkills].map(skill => [skill.name, skill])).values()]
}

export const formatAvailableSkills = (skills: readonly Skill[]): string => {
  const visible = skills.filter(skill => !skill.disableModelInvocation)
  if (visible.length === 0)
    return ''

  const lines = [
    'The following skills provide specialized instructions for specific tasks. When a task matches a skill\'s description, read the SKILL.md at the listed location via exec_command before proceeding. When a skill references relative paths, resolve them against the skill\'s directory (the parent of SKILL.md) and use absolute paths in tool calls.',
    '',
    '<available_skills>',
  ]

  for (const skill of visible) {
    lines.push('  <skill>')
    lines.push(`    <name>${escapeXml(skill.name)}</name>`)
    lines.push(`    <description>${escapeXml(skill.description)}</description>`)
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`)
    lines.push('  </skill>')
  }

  lines.push('</available_skills>')
  return lines.join('\n')
}

export const extractExplicitSkillNames = (prompt: string, skills: readonly Skill[]): string[] => {
  if (skills.length === 0)
    return []

  const known = new Set(skills.map(skill => skill.name))
  const slashName = /^\/([a-z0-9-]+)(?=\s|$)/.exec(prompt.trimStart())?.[1]
  const dollarNames = [...prompt.matchAll(/(?:^|[\s(])\$([a-z0-9-]+)(?=$|[\s.,;:!?)])/g)].map(match => match[1])
  return [...new Set([slashName, ...dollarNames])].filter((name): name is string => name != null && known.has(name))
}

export const collectActivatedSkillNames = (messages: readonly Message[]): Set<string> => {
  const activated = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'user')
      continue
    const text = typeof message.content === 'string'
      ? message.content
      : message.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n')
    for (const match of text.matchAll(/<skill_content\s+name="([^"]+)">/g))
      activated.add(unescapeXml(match[1]))
  }
  return activated
}

const collectSkillResources = async (baseDir: string): Promise<string[]> => {
  const skillPath = join(baseDir, 'SKILL.md')
  const resources: string[] = []
  const queue: string[] = [baseDir]

  while (queue.length > 0) {
    const dir = queue.shift()!
    for (const entry of await readSortedEntries(dir)) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory())
        queue.push(fullPath)
      else if (entry.isFile() && fullPath !== skillPath)
        resources.push(relative(baseDir, fullPath).split(sep).join('/'))
      if (resources.length >= MAX_SKILL_RESOURCES)
        return resources
    }
  }

  return resources
}

export const formatSkillActivation = async (skill: Skill): Promise<string> => {
  const rawContent = await readFile(skill.filePath, 'utf8')
  const { body } = parseSkillDocument(rawContent)
  const resources = await collectSkillResources(skill.baseDir)

  const lines = [
    `<skill_content name="${escapeXml(skill.name)}">`,
    body,
    '',
    `Skill directory: ${skill.baseDir}`,
    'Relative paths in this skill are relative to the skill directory.',
  ]

  if (resources.length > 0) {
    lines.push('<skill_resources>')
    for (const file of resources)
      lines.push(`  <file>${escapeXml(file)}</file>`)
    lines.push('</skill_resources>')
  }

  lines.push('</skill_content>')
  return lines.join('\n')
}
