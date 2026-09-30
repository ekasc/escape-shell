/**
 * Harness benchmark: the per-turn JS work in the shell.
 *
 * Deliberately run through the vitest harness with FakeEngine rather than by
 * importing app.tsx into a bare bun script. app.tsx creates a real engine client
 * on import, and a second engine is exactly what the dev rules forbid.
 *
 * Read the numbers as JS work, not as frame time. The test renderer does no
 * real layout, measurement, or compositing, so a row that would cost a
 * millisecond of paint here costs nothing measured here. What it does capture
 * faithfully is parsing, the streaming state machine, and React reconciliation.
 *
 *   bunx vitest run harness.bench.test.tsx
 */
import { describe, expect, it } from 'vitest'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { parseTranscriptPage } from './agent-client'
import { FakeEngine } from './fake-engine'
import { ChatApp, SafeMdxContent, createBlockStreamer, deriveTimelineRows, parseAnsi } from './app'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function report(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!
  console.log(
    `  ${label.padEnd(40)} median ${median.toFixed(3).padStart(8)}ms  p95 ${p95.toFixed(3).padStart(8)}ms`,
  )
  return median
}

function measure(label: string, iterations: number, fn: () => void): number {
  for (let i = 0; i < 3; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  return report(label, samples)
}

const PARA =
  'The turn ran a handful of tools, edited a few files, and then explained what it ' +
  'changed and why the previous approach was wrong. Repeated to approximate a ' +
  'paragraph of ordinary prose in a transcript, which is what the parser actually sees.\n\n'

/** A transcript shaped like a real one: prose, tool calls, and their results. */
function transcriptPage(turns: number) {
  const entries: unknown[] = []
  for (let t = 0; t < turns; t++) {
    entries.push({ id: `u${t}`, type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'fix the failing test' }] } })
    entries.push({
      id: `a${t}`,
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: PARA },
          { type: 'toolCall', id: `tc${t}`, name: 'edit', arguments: { path: 'app.tsx' } },
          { type: 'text', text: PARA },
        ],
      },
    })
    entries.push({
      id: `r${t}`,
      type: 'message',
      message: { role: 'toolResult', toolCallId: `tc${t}`, toolName: 'edit', content: [{ type: 'text', text: 'ok' }] },
    })
  }
  return { entries, hasMore: false, earliestId: 'u0' }
}

describe('harness benchmark', () => {
  it('parses a transcript page', () => {
    console.log('\ntranscript load (parseTranscriptPage):')
    for (const turns of [20, 100, 400]) {
      const page = transcriptPage(turns)
      const t0 = performance.now()
      const out = parseTranscriptPage(page)
      expect(out.messages.length).toBeGreaterThan(0)
      const ms = performance.now() - t0
      report(`${turns} turns (${page.entries.length} entries)`, [ms])
    }
  })

  it('runs the block streamer over a whole answer', () => {
    console.log('\nstreaming (createBlockStreamer):')
    // A long answer arrives in small deltas; the streamer is what turns them
    // into paragraph-sized releases.
    const answer = PARA.repeat(60)
    const deltas = answer.match(/.{1,12}/gs) ?? []
    measure(`${deltas.length} deltas -> paragraph releases`, 20, () => {
      const stream = createBlockStreamer(() => {})
      for (const d of deltas) stream.push(d)
      stream.flush()
    })
  })

  it('parses ANSI in a streamed chunk', () => {
    console.log('\nansi (parseAnsi):')
    const line = '[32m+ added line[0m with [1mbold[0m and a plain tail'
    measure('one styled line', 20000, () => {
      parseAnsi(line)
    })
  })

  describeNative('markdown', () => {
    it('parses and reconciles a markdown answer', async () => {
      console.log('\nmarkdown (SafeMdxContent: parse + reconcile):')
      // parseMdx is module-private; SafeMdxContent is the exported path that
      // calls it, and it is the more honest number anyway because it includes
      // the React reconciliation a real answer pays.
      const md = `## Heading\n\n${PARA}\n- one\n- two\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n\n${PARA}`
      const samples: number[] = []
      for (let i = 0; i < 20; i++) {
        const { render, renderer } = createTestRoot()
        const start = performance.now()
        render(<SafeMdxContent source={md} onCopy={async () => {}} />)
        for (let k = 0; k < 4; k++) await new Promise((r) => setTimeout(r, 0))
        renderer.flush()
        samples.push(performance.now() - start)
      }
      const out = report('a heading, prose, list, fence', samples)
      expect(out).toBeGreaterThan(0)
    }, 30_000)

    it('scales with answer length, not with the new text', async () => {
      // The cost that matters: `useMemo(() => parseMdx(source), [source])`
      // re-parses the whole accumulated answer every time a block is released,
      // so a streaming answer pays this repeatedly on a document that grows.
      // These are the per-release costs at each length, which is what a turn
      // actually pays N times.
      console.log('\nmarkdown re-parse at growing answer length (per release):')
      for (const blocks of [2, 8, 32, 128]) {
        const md = `## Heading\n\n${PARA.repeat(blocks)}\n- one\n- two\n\n\`\`\`ts\nconst x = 1\n\`\`\``
        const samples: number[] = []
        for (let i = 0; i < 8; i++) {
          const { render, renderer } = createTestRoot()
          const start = performance.now()
          render(<SafeMdxContent source={md} onCopy={async () => {}} />)
          for (let k = 0; k < 3; k++) await new Promise((r) => setTimeout(r, 0))
          renderer.flush()
          samples.push(performance.now() - start)
        }
        report(`${String(md.length).padStart(6)} chars (${blocks} paragraphs)`, samples)
      }
    }, 60_000)
  })

  it('derives timeline rows', () => {
    console.log('\nrow model (deriveTimelineRows):')
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: PARA,
      turnId: `t${Math.floor(i / 4)}`,
      tools: i % 4 === 1 ? [{ id: `x${i}`, name: 'edit', status: 'done' as const }] : undefined,
    }))
    measure('200 messages -> rows', 500, () => {
      deriveTimelineRows(messages, [])
    })
  })

  describeNative('mount', () => {
    it('mounts the app and runs a full turn', async () => {
      console.log('\nrender (test renderer, no real layout):')
      const mounts: number[] = []
      for (let i = 0; i < 5; i++) {
        const fake = new FakeEngine()
        fake.replyText = PARA.repeat(12)
        fake.toolScript = [{ name: 'read', output: 'contents' }, { name: 'edit', output: 'ok' }]
        const { render, renderer } = createTestRoot()
        const t0 = performance.now()
        render(<ChatApp client={fake} />)
        for (let k = 0; k < 8; k++) await new Promise((r) => setTimeout(r, 0))
        renderer.flush()
        mounts.push(performance.now() - t0)
      }
      report('cold mount -> first paint', mounts)
    }, 30_000)
  })
})
