import { defineConfig } from 'vite'
import vue from '../src/index'

const config = defineConfig({
  resolve: {
    alias: {
      '@': __dirname
    }
  },
  build: {
    sourcemap: true,
    minify: false
  },
  plugins: [
    vue(),
    {
      name: 'customBlock',
      transform(code, id) {
        if (/type=custom/i.test(id)) {
          const trimmed = code.trim()
          const customBlockCode = /\bexport\s+default\b/.test(trimmed)
            ? trimmed.replace(/export default/, 'const __customBlock =')
            : `const __customBlock = ${trimmed}`
          return {
            code: `${customBlockCode}
            export default function (Comp) {
              if (!Comp.__customBlock) {
                Comp.__customBlock = {};
              }
              Object.assign(Comp.__customBlock, __customBlock);
            }`,
            map: null
          }
        }
      }
    }
  ]
})

export default config
