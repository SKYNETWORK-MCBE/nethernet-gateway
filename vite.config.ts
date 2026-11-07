import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    dts: true,
    entry: [
      'src/index.ts',
      'src/minecraft/index.ts',
      'src/node/index.ts',
      'src/bun/index.ts',
      'src/cloudflare-workers/index.ts',
      'src/deno/index.ts',
    ],
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    singleQuote: true,
  },
  staged: {
    '*.{js,ts}': 'vp check --fix',
  },
});
