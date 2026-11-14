import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: { FWT_HOME: join(tmpdir(), 'fwt-test-home-unused') },
    include: ['packages/*/test/**/*.test.ts'],
  },
})
