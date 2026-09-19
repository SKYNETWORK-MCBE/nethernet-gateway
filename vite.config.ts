import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    dts: true,
    entry: 'src/index.ts',
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
});
