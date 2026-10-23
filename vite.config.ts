import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // 5173 belongs to meshcore-console
  server: { port: 5174, strictPort: true },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
