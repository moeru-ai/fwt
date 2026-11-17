import type { FwtDirs } from '../home'

import process from 'node:process'

import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { parse, stringify } from 'smol-toml'

import * as v from 'valibot'

export const wireProtocolSchema = v.picklist(['chat', 'responses', 'messages'])

export type WireProtocol = v.InferOutput<typeof wireProtocolSchema>

export const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1))

const httpUrl = v.pipe(v.string(), v.url(), v.regex(/^https?:/, 'Base URL must use http or https.'))

export const modelInfoSchema = v.strictObject({
  context: v.optional(positiveInteger),
  effort: v.optional(v.string()),
  image: v.optional(v.boolean()),
  max_output: v.optional(positiveInteger),
  protocol: v.optional(wireProtocolSchema),
})

const providerConfigSchema = v.strictObject({
  base_url: v.pipe(v.record(wireProtocolSchema, httpUrl), v.minEntries(1, 'Set at least one base URL.')),
  env_key: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
  model: v.optional(v.string()),
  models: v.optional(v.record(v.string(), modelInfoSchema)),
  name: v.optional(v.string()),
})

export type ProviderConfig = v.InferOutput<typeof providerConfigSchema>

const configSchema = v.strictObject({
  provider: v.optional(v.string()),
  providers: v.optional(v.record(v.string(), providerConfigSchema), {}),
  shell: v.optional(v.tupleWithRest([v.string()], v.string())),
})

type Config = v.InferOutput<typeof configSchema>

const authSchema = v.record(v.string(), v.strictObject({ api_key: v.string() }))

type Auth = v.InferOutput<typeof authSchema>

const validate = <T>(schema: v.GenericSchema<unknown, T>, value: unknown, path: string): T => {
  const result = v.safeParse(schema, value)
  if (result.success)
    return result.output
  const issue = result.issues[0]
  const at = v.getDotPath(issue)
  throw new Error(`Invalid ${path}${at != null ? ` at ${at}` : ''}: ${issue.message}`)
}

const decodeFile = (path: string, decode: (raw: string) => unknown): unknown => {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {}
    throw error
  }
  return raw.trim() === '' ? {} : decode(raw)
}

const writeAtomic = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { mode: 0o700, recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 })
    await rename(tempPath, path)
  }
  catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

export const readConfig = (dirs: FwtDirs): Config => {
  const path = join(dirs.config, 'config.toml')
  return validate(configSchema, decodeFile(path, parse), path)
}

export const writeConfig = async (dirs: FwtDirs, config: Config): Promise<void> => {
  const path = join(dirs.config, 'config.toml')
  await writeAtomic(path, stringify(validate(configSchema, config, path)))
}

export const readAuth = (dirs: FwtDirs): Auth => {
  const path = join(dirs.data, 'auth.json')
  return validate(authSchema, decodeFile(path, raw => JSON.parse(raw) as unknown), path)
}

export const writeAuth = async (dirs: FwtDirs, auth: Auth): Promise<void> =>
  writeAtomic(join(dirs.data, 'auth.json'), `${JSON.stringify(auth, null, 2)}\n`)
