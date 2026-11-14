import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

describe('fwtDirs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('uses the XDG base directories unless FWT_HOME is set', async () => {
    vi.stubEnv('FWT_HOME', '')
    vi.stubEnv('XDG_CONFIG_HOME', '/x/config')
    vi.stubEnv('XDG_DATA_HOME', '/x/data')
    vi.stubEnv('XDG_STATE_HOME', '/x/state')
    vi.stubEnv('XDG_CACHE_HOME', '/x/cache')
    vi.resetModules()
    const { fwtDirs } = await import('../src/home')

    expect(fwtDirs()).toEqual({
      cache: join('/x/cache', 'fwt'),
      config: join('/x/config', 'fwt'),
      data: join('/x/data', 'fwt'),
      state: join('/x/state', 'fwt'),
    })

    vi.stubEnv('FWT_HOME', '/one/dir')
    expect(fwtDirs()).toEqual({ cache: '/one/dir', config: '/one/dir', data: '/one/dir', state: '/one/dir' })
    expect(fwtDirs('/explicit')).toEqual({ cache: '/explicit', config: '/explicit', data: '/explicit', state: '/explicit' })
  })
})
