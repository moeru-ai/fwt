import { defineConfig } from '@moeru/eslint-config'

export default defineConfig()
  .append({
    files: ['packages/fwt/src/bin.ts'],
    rules: {
      '@masknet/no-top-level': 'off',
    },
  })
