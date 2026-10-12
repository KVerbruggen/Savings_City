import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Relative base: assets resolve correctly on GitHub Pages under /<repo>/ or anywhere else.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
})
