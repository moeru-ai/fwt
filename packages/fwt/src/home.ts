import process from 'node:process'

import { join, resolve } from 'node:path'

import { xdgCache, xdgConfig, xdgData, xdgState } from 'xdg-basedir'

export interface FwtDirs {
  cache: string
  config: string
  data: string
  state: string
}

export const fwtDirs = (home = process.env.FWT_HOME): FwtDirs => {
  if (home != null && home !== '') {
    const dir = resolve(home)
    return { cache: dir, config: dir, data: dir, state: dir }
  }
  const under = (base: string | undefined): string => {
    if (base == null)
      throw new Error('Cannot find the home directory; set FWT_HOME.')
    return join(base, 'fwt')
  }
  return { cache: under(xdgCache), config: under(xdgConfig), data: under(xdgData), state: under(xdgState) }
}
