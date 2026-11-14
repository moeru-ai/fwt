import type { ModelConfigInput } from '../providers'

export type AcpProtocolVersion = 1 | 2

export interface AcpServerOptions {
  input?: NodeJS.ReadableStream
  maxTurns?: number
  modelConfig?: ModelConfigInput
  output?: AcpWritable
  permissionMode?: PermissionMode
  sessionsDir: string
  signal?: AbortSignal
}

export type PermissionMode = 'ask' | 'auto'

export type PermissionOutcome = 'allow_always' | 'allow_once' | 'cancelled' | 'reject_always' | 'reject_once'

interface AcpWritable {
  write: (chunk: string) => unknown
}
