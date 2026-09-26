/**
 * Drive the chat app like Playwright and write a PNG.
 *
 * `launch()` starts `app.tsx` as a child process and speaks the automation
 * protocol over its stdin pipe. `clock.pause()` freezes native motion, so the
 * screenshot is the same on every run.
 *
 *   bun run screenshot           writes screenshots/chat.png
 *   bun run screenshot out.png   writes that path instead
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { launch } from '@gpuix/react/automation'

const out = process.argv[2] ?? 'screenshots/chat.png'
mkdirSync(path.dirname(out), { recursive: true })

const app = await launch({
  command: 'bun',
  args: ['app.tsx'],
  env: { GPUIX_BACKGROUND: '1' },
})
await app.getByTestId('chat-input').waitFor({ timeoutMs: 60_000 })
await app.clock.pause()
await app.screenshot({ path: out })
await app.close()

console.log(`[screenshot] wrote ${out}`)
