import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    dts: true,
    entry: ['src/index.ts', 'src/minecraft/index.ts'],
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
