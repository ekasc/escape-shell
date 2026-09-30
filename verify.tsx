import { launch } from '@gpuix/react/automation'

const app = await launch({
  command: `${process.cwd()}/build/release/escape-shell`,
  cwd: '/Users/ekassinghchhabra/Projects/escape',
  env: { ...process.env, GPUIX_BACKGROUND: '1' },
})
await app.getByTestId('chat-input').waitFor({ timeoutMs: 30_000 })
console.log('  app up')

// The affordance exists at all, before touching it.
const addRow = await app.getByTestId('add-project').count()
console.log(`  "Add project" row present: ${addRow === 1}`)

// Open it and submit a real directory through the real engine.
await app.getByTestId('add-project').click()
await app.getByTestId('add-project-input').waitFor({ timeoutMs: 10_000 })
console.log('  form opens')

// A path that does not exist must be refused, visibly.
await app.getByTestId('add-project-input').fill('/nope/not/here')
await app.getByTestId('add-project-confirm').click()
await app.getByTestId('add-project-error').waitFor({ timeoutMs: 10_000 })
console.log(`  bad path refused: ${JSON.stringify(await app.getByTestId('add-project-error').textContent())}`)

// A real one must land as a sidebar space.
await app.getByTestId('add-project-input').fill('/Users/ekassinghchhabra/Projects/escape/engine')
await app.getByTestId('add-project-confirm').click()
await app.getByTestId('space-/Users/ekassinghchhabra/Projects/escape/engine').waitFor({ timeoutMs: 15_000 })
console.log('  real project added and shown as a space')
console.log(`  form closed after success: ${(await app.getByTestId('add-project').count()) === 1}`)

await app.close()
