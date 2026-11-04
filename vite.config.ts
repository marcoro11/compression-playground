import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub Pages serves a project site from https://<user>.github.io/<repo>/, so
 * the built asset URLs need that prefix or every one of them 404s and the page
 * comes up blank. The deploy workflow passes the repo name in through
 * BASE_PATH, which means renaming the repository needs no change here.
 *
 * Left unset — local dev, local preview — everything stays at the root.
 */
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
})
