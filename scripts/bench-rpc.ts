/**
 * End-to-end RPC round-trip benchmark against the real engine binary.
 *
 * Everything measured elsewhere in-process excludes the two costs a real turn
 * actually pays: spawning the engine, and the JSONL round-trip over its pipes.
 * This measures those, on a throwaway repository and session directory, against
 * a standalone binary. It never touches a running dev instance.
 *
 *   bun run scripts/bench-rpc.ts [iterations]
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(here, '../build/engine/escape')
const ITERATIONS = Number(process.argv[2] ?? 40)

/** A repo with real history and a few edits, so vcs_status has work to do. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'escape-bench-repo-'))
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'bench',
    GIT_AUTHOR_EMAIL: 'bench@e',
    GIT_COMMITTER_NAME: 'bench',
    GIT_COMMITTER_EMAIL: 'bench@e',
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { env, stdio: 'pipe' })
  git('init', '-q')
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(dir, `file${String(i).padStart(3, '0')}.go`), `package main\n\n// ${i}\nfunc f${i}() {}\n`)
  }
  git('add', '-A')
  git('commit', '-qm', 'seed')
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(dir, `file${String(i).padStart(3, '0')}.go`), `package main\n\n// changed ${i}\nfunc f${i}() {}\n`)
  }
  return dir
}

type Rpc = {
  call: (command: string, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>
  stop: () => Promise<void>
}

async function startEngine(cwd: string, sessionRoot: string): Promise<Rpc> {
  const proc = Bun.spawn([BIN, 'rpc', '--cwd', cwd], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, ESCAPE_SESSION_ROOT: sessionRoot },
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const waiters: Array<(value: Record<string, unknown>) => void> = []

  // Drain continuously: a single unread line would block every later response.
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter(msg)
      }
    }
  })()

  return {
    call(command, extra = {}) {
      return new Promise((resolveCall) => {
        waiters.push(resolveCall)
        ;(proc.stdin as FileSink).write(`${JSON.stringify({ type: command, ...extra })}\n`)
      })
    },
    async stop() {
      ;(proc.stdin as FileSink).end()
      await proc.exited
    },
  }
}

const ms = (n: bigint) => `${(Number(n) / 1e6).toFixed(3)}ms`

async function time(label: string, fn: () => Promise<unknown>, iterations = ITERATIONS) {
  // Warm the process so the first-call cost does not distort the median.
  for (let i = 0; i < 3; i++) await fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    const result = await fn()
    samples.push(performance.now() - start)
    // A rejected request returns instantly and would post a beautiful, false
    // number. An error is a broken benchmark, not a fast command.
    if (result && typeof result === 'object' && 'success' in result && result.success !== true) {
      throw new Error(`bench: "${label}" failed on iteration ${i}: ${JSON.stringify(result)}`)
    }
  }
  samples.sort((a, b) => a - b)
  const median = samples[Math.floor(samples.length / 2)]!
  const p95 = samples[Math.floor(samples.length * 0.95)]!
  console.log(
    `  ${label.padEnd(34)} median ${median.toFixed(3).padStart(8)}ms   p95 ${p95.toFixed(3).padStart(8)}ms   min ${samples[0]!.toFixed(3).padStart(8)}ms`,
  )
  return median
}

const repo = makeRepo()
const sessionRoot = mkdtempSync(join(tmpdir(), 'escape-bench-sess-'))
mkdirSync(sessionRoot, { recursive: true })

const engine = await startEngine(repo, sessionRoot)
console.log(`engine: ${BIN}`)
console.log(`repo:   ${repo} (40 files, 5 modified)\n`)
console.log('RPC round-trip, process up:')

try {
  await time('get_providers', () => engine.call('get_providers'))
  await time('get_available_thinking_levels', () => engine.call('get_available_thinking_levels'))
  await time('vcs_status (4 git spawns)', () => engine.call('vcs_status'))
  await time('vcs_file_diff (1 file)', () => engine.call('vcs_file_diff', { filePath: 'file000.go' }))
  await time('list_skills', () => engine.call('list_skills'))
  await time('set_thinking_level (write)', () => engine.call('set_thinking_level', { level: 'medium' }))
} finally {
  await engine.stop()
  rmSync(repo, { recursive: true, force: true })
  rmSync(sessionRoot, { recursive: true, force: true })
}

// Cold start, measured separately: what the user waits for when launching.
console.log('\ncold start (fresh engine process):')
{
  const dir = mkdtempSync(join(tmpdir(), 'escape-bench-cold-'))
  try {
    const start = performance.now()
    const e = await startEngine(repo, dir)
    await e.call('get_providers')
    const first = performance.now() - start
    const second = performance.now()
    await e.call('get_providers')
    const warm = performance.now() - second
    console.log(`  spawn + first response              ${first.toFixed(3).padStart(8)}ms`)
    console.log(`  subsequent round-trip               ${warm.toFixed(3).padStart(8)}ms`)
    await e.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
rmSync(repo, { recursive: true, force: true })
rmSync(sessionRoot, { recursive: true, force: true })
