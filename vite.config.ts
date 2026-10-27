import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const serverProxy = {
  '/api': 'http://127.0.0.1:5742',
  '/ws': { target: 'ws://127.0.0.1:5742', ws: true },
}

export default defineConfig({
  plugins: [react()],
  // 5173 belongs to meshcore-console. /api and /ws go to the console server (pnpm server) on 5742, so
  // the page reaches it on its own origin.
  server: { port: 5174, strictPort: true, proxy: serverProxy },
  preview: { proxy: serverProxy },
  test: {
    include: ['test/**/*.test.ts', 'server/**/*.test.ts'],
  },
})
