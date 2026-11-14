import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  collectActivatedSkillNames,
  discoverSkills,
  extractExplicitSkillNames,
  formatAvailableSkills,
  formatSkillActivation,
  parseSkillDocument,
} from '../src/agent'

describe('agent skills', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()
      if (fn != null)
        await fn()
    }
  })

  const makeTempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'fwt-skills-'))
    cleanups.push(async () => rm(dir, { force: true, recursive: true }))
    return dir
  }

  it('parses frontmatter with colons, block scalars, disable-model-invocation, and nested blocks', () => {
    const doc = [
      '\uFEFF---',
      'name: sample-skill',
      'description: |',
      '  First line: with colon.',
      '  Second line with details.',
      'disable-model-invocation: true',
      'metadata:',
      '  author: example',
      '---',
      '',
      '# Instructions',
      'Use [guide](references/guide.md).',
    ].join('\n')

    const parsed = parseSkillDocument(doc)
    expect(parsed).toEqual({
      body: '# Instructions\nUse [guide](references/guide.md).',
      description: 'First line: with colon.\nSecond line with details.',
      disableModelInvocation: true,
      hasValidFrontmatter: true,
      name: 'sample-skill',
    })

    const folded = parseSkillDocument([
      '---',
      'description: >',
      '  Folded line one',
      '  folded line two',
      '---',
      'Body',
    ].join('\n'))
    expect(folded.description).toBe('Folded line one folded line two')

    const unclosed = parseSkillDocument('---\nname: broken\ndescription: missing close')
    expect(unclosed.hasValidFrontmatter).toBe(false)

    const emptyDesc = parseSkillDocument('---\nname: empty\ndescription:\n---\nBody')
    expect(emptyDesc.hasValidFrontmatter).toBe(true)
    expect(emptyDesc.description).toBeUndefined()
  })

  it('discovers user and project skills with project override, leaf stop, ignores, and symlink safety', async () => {
    const root = await makeTempDir()
    const userSkillsDir = join(root, 'user-skills')
    const projectDir = join(root, 'project')
    const projectSkillsDir = join(projectDir, '.agents', 'skills')

    await mkdir(join(userSkillsDir, 'shared-skill'), { recursive: true })
    await writeFile(join(userSkillsDir, 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: user version\n---\nUser body')

    await mkdir(join(userSkillsDir, 'nested', 'only-user'), { recursive: true })
    await writeFile(join(userSkillsDir, 'nested', 'only-user', 'SKILL.md'), '---\nname: only-user\ndescription: user only\n---\nOnly user')

    await mkdir(join(userSkillsDir, 'no-desc'), { recursive: true })
    await writeFile(join(userSkillsDir, 'no-desc', 'SKILL.md'), '---\nname: no-desc\n---\nSkip me')

    await mkdir(join(projectSkillsDir, 'shared-skill', 'nested-ignored'), { recursive: true })
    await writeFile(join(projectSkillsDir, 'shared-skill', 'SKILL.md'), '---\nname: shared-skill\ndescription: project version: wins\n---\nProject body')
    await writeFile(join(projectSkillsDir, 'shared-skill', 'nested-ignored', 'SKILL.md'), '---\nname: nested-ignored\ndescription: should not load\n---\nNested')

    await mkdir(join(projectSkillsDir, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(join(projectSkillsDir, 'node_modules', 'ignored', 'SKILL.md'), '---\nname: ignored\ndescription: ignored\n---\nIgnored')

    await mkdir(join(projectSkillsDir, '.hidden', 'ignored'), { recursive: true })
    await writeFile(join(projectSkillsDir, '.hidden', 'ignored', 'SKILL.md'), '---\nname: hidden\ndescription: hidden\n---\nHidden')

    await mkdir(join(projectSkillsDir, 'mismatch-dir'), { recursive: true })
    await writeFile(join(projectSkillsDir, 'mismatch-dir', 'SKILL.md'), '---\nname: renamed-skill\ndescription: still loads\n---\nBody')

    await symlink(projectSkillsDir, join(projectSkillsDir, 'loop-link'))

    const result = await discoverSkills({
      cwd: projectDir,
      projectSkillsDir,
      userSkillsDir,
    })

    const byName = new Map(result.map(skill => [skill.name, skill]))
    expect([...byName.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['only-user', 'renamed-skill', 'shared-skill'])
    expect(byName.get('shared-skill')?.source).toBe('project')
    expect(byName.get('shared-skill')?.description).toBe('project version: wins')
    expect(byName.has('nested-ignored')).toBe(false)
    expect(byName.has('no-desc')).toBe(false)
  })

  it('formats Tier 1 disclosure XML, extracts explicit references, and formats Tier 2 activation with resources', async () => {
    const dir = await makeTempDir()
    const skillDir = join(dir, 'deploy-app')
    await mkdir(join(skillDir, 'scripts'), { recursive: true })
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await mkdir(join(skillDir, '.git'), { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: deploy-app\ndescription: Deploy <app> & "verify"\n---\nRun `scripts/deploy.sh`.')
    await writeFile(join(skillDir, 'scripts', 'deploy.sh'), '#!/bin/sh\necho ok\n')
    await writeFile(join(skillDir, 'references', 'checklist.md'), '# Checklist\n')
    await writeFile(join(skillDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const visibleSkill = {
      baseDir: skillDir,
      description: 'Deploy <app> & "verify"',
      disableModelInvocation: false,
      filePath: join(skillDir, 'SKILL.md'),
      name: 'deploy-app',
      source: 'project' as const,
    }
    const hiddenSkill = {
      ...visibleSkill,
      disableModelInvocation: true,
      name: 'secret-skill',
    }

    const xml = formatAvailableSkills([visibleSkill, hiddenSkill])
    expect(xml).toContain('<available_skills>')
    expect(xml).toContain('<name>deploy-app</name>')
    expect(xml).toContain('<description>Deploy &lt;app&gt; &amp; &quot;verify&quot;</description>')
    expect(xml).not.toContain('secret-skill')
    expect(formatAvailableSkills([hiddenSkill])).toBe('')

    expect(extractExplicitSkillNames('/deploy-app and also $secret-skill then $deploy-app and $unknown', [visibleSkill, hiddenSkill])).toEqual([
      'deploy-app',
      'secret-skill',
    ])

    const activation = await formatSkillActivation(visibleSkill)
    expect(activation).toContain('<skill_content name="deploy-app">')
    expect(activation).toContain('Run `scripts/deploy.sh`.')
    expect(activation).toContain(`Skill directory: ${skillDir}`)
    expect(activation).toContain('<skill_resources>')
    expect(activation).toContain('<file>references/checklist.md</file>')
    expect(activation).toContain('<file>scripts/deploy.sh</file>')
    expect(activation).not.toContain('<file>SKILL.md</file>')
    expect(activation).not.toContain('.git/HEAD')

    const activated = collectActivatedSkillNames([
      { content: activation, role: 'user' },
      { content: [{ text: '<skill_content name="secret-skill">\nbody\n</skill_content>', type: 'text' }], role: 'user' },
    ])
    expect([...activated].sort((a, b) => a.localeCompare(b))).toEqual(['deploy-app', 'secret-skill'])
  })
})
