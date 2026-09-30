/**
 * Tests for the engine-backed chat app.
 *
 * Renderer tests drive ChatApp against FakeEngine, a scripted AgentClient
 * that behaves like the engine at the RPC boundary without spawning a
 * process. Pure helpers (diff parsing, timeline derivation, formatting) are
 * tested directly.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { motion, render, resetRender } from '@gpuix/react'
import { DURATION, __setReducedMotionForTest, fadeIn } from './motion'
import { normaliseKey } from './keys'
import { focusRingForTest } from './focus'
import { resolveEngineCwd } from './agent-client'
import { C } from './theme-tokens'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer, TestRenderer } from '@gpuix/react/testing'
import {
  ChatApp,
  FilterSelect,
  MONO_FONTS,
  SANS_FONTS,
  SafeMdxContent,
  SafeMdxTranscript,
  activityDuration,
  applyTurnEvent,
  applyTypography,
  commitBlockedReason,
  agentStatusLabel,
  createBlockStreamer,
  currentTheme,
  deriveTimelineRows,
  formatDuration,
  groupForSession,
  THEMES,
  dispatchWindowKey,
  hasAnsi,
  highlightRuns,
  parseAnsi,
  parseUnifiedDiff,
  projectName,
  reduceAgentStatus,
  relativeTime,
  turnDurationLabel,
  validatePrompt,
} from './app'
import type { VcsStatus } from './agent-client'
import { parseTranscriptPage } from './agent-client'
import { FakeEngine } from './fake-engine'
import {
  isMonoFamily,
  parseFontFamilies,
  splitSystemFonts,
  toFontOption,
} from './fonts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'screenshots')

beforeAll(() => {
  fs.mkdirSync(SHOTS, { recursive: true })
})

type Renderer = ReturnType<typeof createTestRoot>['renderer']

/** The test renderer stores a text run's style on the sibling node that
 *  precedes its content, so look the style up beside the content. */
function textRunStyle(
  renderer: Renderer,
  content: string,
): Record<string, unknown> | undefined {
  const texts = renderer.findByType('text')
  const index = texts.findIndex((el) => el.text === content)
  if (index <= 0) return undefined
  return texts[index - 1]!.style as Record<string, unknown>
}

async function settle(renderer: Renderer, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  renderer.flush()
}

function typeSend(renderer: Renderer, word: string): void {
  const textarea = renderer.findByType('textarea')[0]!
  renderer.nativeSimulateKeystrokes(textarea.id, word.split('').join(' '))
  renderer.nativeSimulateKeystrokes(textarea.id, 'enter')
}

/** Opens the add-project sheet and waits for its first result to land. */
async function openAddProject(
  renderer: ReturnType<typeof createTestRoot>['renderer'],
  app: { getByTestId: (id: string) => { click: () => Promise<void> } },
  fake: FakeEngine,
) {
  await app.getByTestId('add-project').click()
  for (let i = 0; i < 40 && !fake.calls.some((c) => c.method === 'searchDirs'); i++) {
    await new Promise((r) => setTimeout(r, 10))
  }
  await settle(renderer)
}

const DAY = 24 * 60 * 60 * 1000

describe('diff parsing', () => {
  it('splits files and reconstructs old/new texts', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' same',
      '-old',
      '+new',
      'diff --git a/b.ts b/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/b.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(2)
    expect(files[0]).toEqual({ path: 'a.ts', oldText: 'same\nold', newText: 'same\nnew', added: 1, removed: 1 })
    expect(files[1]).toEqual({ path: 'b.ts', oldText: '', newText: 'one\ntwo', added: 2, removed: 0 })
  })

  it('returns no files for an empty patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('No uncommitted changes.')).toEqual([])
  })
})

describe('session grouping and labels', () => {
  it('buckets sessions into Today/Yesterday/This Month/Older', () => {
    const now = new Date(2026, 8, 29, 12, 0, 0).getTime()
    expect(groupForSession(now - 1000, now)).toBe('Today')
    expect(groupForSession(now - 26 * 3600 * 1000, now)).toBe('Yesterday')
    expect(groupForSession(now - 5 * DAY, now)).toBe('This Month')
    expect(groupForSession(now - 60 * DAY, now)).toBe('Older')
  })

  it('formats relative times', () => {
    const now = Date.now()
    expect(relativeTime(now, now)).toBe('now')
    expect(relativeTime(now - 16 * 60 * 1000, now)).toBe('16m')
    expect(relativeTime(now - 14 * 3600 * 1000, now)).toBe('14h')
    expect(relativeTime(now - 2 * DAY, now)).toBe('2d')
  })

  it('formats durations and derives fold labels', () => {
    expect(formatDuration(2000)).toBe('Worked for 2 seconds')
    expect(formatDuration(61000)).toBe('Worked for 1 minute')
    expect(activityDuration([])).toBe('Worked')
    expect(
      activityDuration([{ id: 't', name: 'read', status: 'running', createdAt: Date.now() }]),
    ).toBe('Working…')
    const start = 1000
    expect(
      activityDuration([
        { id: 't', name: 'read', status: 'done', createdAt: start, endedAt: start + 9000 },
      ]),
    ).toBe('Worked for 9 seconds')
    // A reloaded transcript has no timestamps. The elapsed time is unknown,
    // not zero, so the label reports the count instead of inventing a duration.
    expect(
      activityDuration([
        { id: 'a', name: 'bash', status: 'done' },
        { id: 'b', name: 'bash', status: 'done' },
        { id: 'c', name: 'read', status: 'done' },
      ]),
    ).toBe('3 tool calls')
    expect(activityDuration([{ id: 'a', name: 'bash', status: 'done' }])).toBe('1 tool call')
  })

  it('labels projects with a fallback', () => {
    expect(projectName('/Users/tester/projects/alpha')).toBe('alpha')
    expect(projectName('/Users/tester/projects/alpha/')).toBe('alpha')
  })

  it('heads each turn with its work and drops orphans', () => {
    // The work fold is a header on the turn, so it comes first — the reader
    // sees what the agent did, then the answer.
    const rows = deriveTimelineRows(
      [
        { id: 'u1', role: 'user', content: 'hi', turnId: 't1' },
        { id: 'a1', role: 'assistant', content: 'hello', turnId: 't1' },
      ],
      [
        { id: 'tool-1', name: 'read', status: 'done', turnId: 't1' },
        { id: 'orphan', name: 'x', status: 'done' },
      ],
    )
    expect(rows.map((r) => r.key)).toEqual(['a:t1', 'm:u1', 'm:a1'])
  })

  it('closes a turn with its changes card, and only when it changed something', () => {
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'fix it', turnId: 't1' },
      { id: 'a1', role: 'assistant' as const, content: 'Fixed.', turnId: 't1' },
      { id: 'u2', role: 'user' as const, content: 'thanks', turnId: 't2' },
      { id: 'a2', role: 'assistant' as const, content: 'Anytime.', turnId: 't2' },
    ]
    const rows = deriveTimelineRows(messages, [], {
      t1: 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b',
    })
    // The card sits at the end of the turn that changed files, not the end of
    // the conversation.
    expect(rows.map((r) => r.key)).toEqual(['m:u1', 'm:a1', 'd:t1', 'm:u2', 'm:a2'])
    const card = rows[2]!
    expect(card.kind === 'diff' && card.turnId).toBe('t1')
  })
})

describe('turn lifecycle', () => {
  it('records the span the engine reports, not a sum of tool timings', () => {
    // The engine's own start-to-end span covers the thinking before the first
    // tool call and the writing after the last one, which a sum of tool
    // timings cannot see.
    let ledger = applyTurnEvent({}, { kind: 'turn_start', turnId: 'r1' }, 1_000).ledger
    const ended = applyTurnEvent(
      ledger,
      { kind: 'turn_end', turnId: 'r1', reason: 'done', state: 'completed' },
      226_000,
    )
    expect(ended.ledger['r1']).toEqual({ state: 'completed', startedAt: 1_000, endedAt: 226_000 })
    expect(turnDurationLabel(ended.ledger['r1'], [])).toBe('Worked for 3 minutes')
  })

  it('keeps an interrupted turn apart from a failed one', () => {
    let ledger = applyTurnEvent({}, { kind: 'turn_start', turnId: 'r1' }, 0).ledger
    ledger = applyTurnEvent(
      ledger,
      { kind: 'turn_end', turnId: 'r1', reason: 'stopped', state: 'interrupted' },
      5_000,
    ).ledger
    expect(ledger['r1']!.state).toBe('interrupted')
    // "Worked for 5 seconds" would claim a completion that did not happen.
    expect(turnDurationLabel(ledger['r1'], [])).toBe('Interrupted')
  })

  it('reports no change for events that say nothing about turns', () => {
    // The reason the reducer returns a verdict at all: writing state per event
    // re-renders the timeline for every text delta on the wire.
    expect(applyTurnEvent({}, { kind: 'text_delta', text: 'hi' }, 5).changed).toBe(false)
    expect(applyTurnEvent({}, { kind: 'settled', reason: 'done' }, 5).changed).toBe(false)
    expect(applyTurnEvent({}, { kind: 'turn_end', reason: 'done', state: 'completed' }, 5).changed)
      .toBe(false)
  })

  it('does not let a repeated turn_end rewrite the recorded end time', () => {
    let ledger = applyTurnEvent({}, { kind: 'turn_start', turnId: 'r1' }, 100).ledger
    ledger = applyTurnEvent(
      ledger,
      { kind: 'turn_end', turnId: 'r1', reason: 'done', state: 'completed' },
      200,
    ).ledger
    const again = applyTurnEvent(
      ledger,
      { kind: 'turn_end', turnId: 'r1', reason: 'done', state: 'completed' },
      9_999,
    )
    expect(again.changed).toBe(false)
    expect(again.ledger).toBe(ledger)
  })

  it('ends the newest running turn when the engine names none', () => {
    // An older engine sends no turnId on turn_end. The only turn that can be
    // running is the newest one, so that is what closes.
    let ledger = applyTurnEvent({}, { kind: 'turn_start', turnId: 'r1' }, 10).ledger
    ledger = applyTurnEvent(ledger, { kind: 'turn_start', turnId: 'r2' }, 20).ledger
    const ended = applyTurnEvent(ledger, { kind: 'turn_end', reason: 'done', state: 'completed' }, 30)
    expect(ended.ledger['r2']!.state).toBe('completed')
    // r1 was left running and must not be closed by a later turn's end.
    expect(ended.ledger['r1']!.state).toBe('running')
  })

  it('falls back to tool timings when the engine recorded no turn', () => {
    // A reloaded transcript was streamed elsewhere, so the ledger is empty and
    // the only known fact is the tool count.
    expect(turnDurationLabel(undefined, [])).toBe('Worked')
    expect(
      turnDurationLabel(undefined, [
        { id: '1', name: 'read', status: 'done', turnId: 'r1' },
        { id: '2', name: 'write', status: 'done', turnId: 'r1' },
      ]),
    ).toBe('2 tool calls')
  })
})

describe('submit validation', () => {
  it('says why a keystroke did nothing instead of returning silently', () => {
    expect(validatePrompt('hi', { busy: true, engineUp: true })).toBe(
      'Wait for the current turn to finish, or stop it first.',
    )
    expect(validatePrompt('hi', { busy: false, engineUp: false })).toBe(
      'The engine is not running.',
    )
    expect(validatePrompt('hi', { busy: false, engineUp: true })).toBeNull()
  })

  it('does not call an empty prompt a refusal', () => {
    // There is nothing to explain: the composer simply has no prompt to send.
    expect(validatePrompt('   ', { busy: false, engineUp: true })).toBeNull()
  })
})

describe('system fonts', () => {
  it('parses fc-list output into deduplicated families', () => {
    expect(
      parseFontFamilies(
        'Helvetica Neue\nMenlo\n.Heiti PUA\nMenlo\nHeiti\\-Bold\nHelvetica\n',
      ),
    ).toEqual(['Heiti-Bold', 'Helvetica Neue', 'Menlo'])
    expect(parseFontFamilies('')).toEqual([])
  })

  it('detects monospace families', () => {
    expect(isMonoFamily('Menlo')).toBe(true)
    expect(isMonoFamily('CommitMono')).toBe(true)
    expect(isMonoFamily('Courier New')).toBe(true)
    expect(isMonoFamily('Helvetica')).toBe(false)
    expect(isMonoFamily('Georgia')).toBe(false)
    expect(isMonoFamily('Arial Unicode MS')).toBe(false)
    expect(isMonoFamily('Source Code Pro')).toBe(true)
  })

  it('splits families into sans and mono pickers', () => {
    const split = splitSystemFonts(['Helvetica Neue', 'Menlo', 'Georgia'])
    expect(split.sans.map((f) => f.id)).toEqual(['Helvetica Neue', 'Menlo', 'Georgia'])
    expect(split.mono.map((f) => f.id)).toEqual(['Menlo'])
    expect(toFontOption('DaddyTime Mono').family).toBe('DaddyTime Mono')
    expect(toFontOption('Menlo').family).toBe('Menlo')
  })

  it('emits bare family names the renderer can resolve', () => {
    for (const option of [...SANS_FONTS, ...MONO_FONTS]) {
      expect(option.family).not.toContain('"')
      expect(option.family).not.toContain(',')
      expect(option.family).toBe(option.id)
    }
  })

  it('lists installed families instead of only the curated few', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot({ width: 1280, height: 1400 })
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-sans').click()
      await settle(renderer)
      // Filter to a known staple that lives past the 120-row cap — proves the system list is present, not just the 5 fallbacks
      const search = renderer.findByTestId('settings-sans-search')!
      renderer.nativeSimulateKeystrokes(search.id, 'v e r')
      await settle(renderer)
      const labels = renderer.getPaintedText()
      expect(labels.some((line) => line.includes('Verdana'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('renders every curated fallback face distinctly', () => {
    const shot = (family: string, name: string): Buffer => {
      const { render, renderer } = createTestRoot({ width: 800, height: 200 })
      render(
        <div style={{ display: 'flex', width: '100%', height: '100%', backgroundColor: '#1A1A1A' }}>
          <text style={{ fontSize: 32, color: '#E2E2E2', fontFamily: family }}>
            The quick brown fox 0123456789
          </text>
        </div>,
      )
      renderer.flush()
      const out = `/tmp/fontface-${name}.png`
      renderer.captureScreenshot(out)
      return fs.readFileSync(out)
    }
    const baseline = shot('___no_such_font___', 'baseline')
    const duds = [...SANS_FONTS, ...MONO_FONTS]
      .filter((option) => shot(option.family, option.id).equals(baseline))
      .map((option) => option.id)
    expect(duds).toEqual([])
  })

  it('filters the font table and previews each face', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot({ width: 1280, height: 1400 })
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-sans').click()
      await settle(renderer)
      // Each row previews its own face: the style lives on the sibling node
      // that precedes the run's content. Filter first so Verdana is visible past the 120-row cap.
      const searchEarly = renderer.findByTestId('settings-sans-search')!
      renderer.nativeSimulateKeystrokes(searchEarly.id, 'v e r')
      await settle(renderer)
      const texts = renderer.findByType('text')
      const rowIndex = texts.findIndex((el) => el.text === 'Verdana')
      expect(rowIndex).toBeGreaterThan(0)
      expect(String(texts[rowIndex - 1]!.style['fontFamily'] ?? '')).toBe('Verdana')

      expect(renderer.getPaintedText()).toContain('Verdana')
      expect(renderer.getPaintedText()).not.toContain('Georgia')
    } finally {
      await app.close()
    }
  })

  it('caps large font lists and narrows on typing', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `Face ${i}`,
      label: `Face ${i}`,
      family: `Face ${i}`,
    }))
    const picked: string[] = []
    const { render, renderer } = createTestRoot()
    let value = ''
    const Rerender = () => {
      render(
        <FilterSelect
          testId="font-probe"
          value={value}
          items={items}
          onChange={(id: string) => {
            picked.push(id)
            value = id
          }}
        />,
      )
    }
    Rerender()
    renderer.flush()

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('font-probe').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('200 of 200 — keep typing to narrow')

      const search = renderer.findByTestId('font-probe-search')!
      renderer.nativeSimulateKeystrokes(search.id, 'f a c e space 1 9')
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('11 of 200')
      await app.getByTestId('font-probe-option-Face 19').click()
      await settle(renderer)
      expect(picked).toEqual(['Face 19'])
    } finally {
      await app.close()
    }
  })

  it('scrolls the open dropdown without moving the page', async () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      id: `Face ${i}`,
      label: `Face ${i}`,
      family: `Face ${i}`,
    }))
    const { render, renderer } = createTestRoot({ width: 1280, height: 800 })
    render(
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', overflowY: 'scroll' }}>
        <div style={{ height: 400, flexShrink: 0 }}>
          <text>Page top</text>
        </div>
        <FilterSelect testId="font-scroll" value="" items={items} onChange={() => {}} />
        <div style={{ height: 400, flexShrink: 0 }}>
          <text>Page bottom</text>
        </div>
      </div>,
    )
    renderer.flush()
    const rowY = () => {
      const texts = renderer.findByType('text')
      const index = texts.findIndex((el) => el.text === 'Page bottom')
      if (index <= 0) return null
      return renderer.getElementBounds(texts[index - 1]!.id)?.y ?? null
    }

    const menuRowY = () => {
      const texts = renderer.findByType('text')
      const index = texts.findIndex((el) => el.text === 'Face 1')
      if (index <= 0) return null
      return renderer.getElementBounds(texts[index - 1]!.id)?.y ?? null
    }
    const searchY = () => {
      const search = renderer.findByTestId('font-scroll-search')
      if (!search) return null
      return renderer.getElementBounds(search.id)?.y ?? null
    }
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('font-scroll').click()
      await settle(renderer)
      const trigger = renderer.findByTestId('font-scroll')!
      const tbox = renderer.getElementBounds(trigger.id)!
      const before = rowY()
      const rowBefore = menuRowY()
      const searchBefore = searchY()
      expect(before).not.toBeNull()
      expect(rowBefore).not.toBeNull()
      expect(searchBefore).not.toBeNull()
      renderer.nativeSimulateScrollWheel(tbox.x + tbox.width / 2, tbox.y + tbox.height + 100, 0, -600)
      await settle(renderer)
      // The menu scrolled under a stationary page and a pinned search bar.
      expect(menuRowY()).toBeLessThan(rowBefore!)
      expect(searchY()).toBe(searchBefore)
      expect(rowY()).toBe(before)
    } finally {
      await app.close()
    }
  })
})

describe('theme object identity', () => {
  it('keeps a stable reference until appearance inputs change', () => {
    const first = currentTheme()
    expect(currentTheme()).toBe(first)
    applyTypography(99, 99, 'compact', true)
    expect(currentTheme()).not.toBe(first)
    expect(currentTheme()).toBe(currentTheme())
  })
})

describeNative('engine chat', () => {
  it('boots sessions, models, and providers from the engine', async () => {
    const fake = new FakeEngine()
    fake.sessions = [
      {
        id: 'sess-1',
        path: 'sess-1',
        cwd: '/Users/tester/projects/alpha',
        name: 'Fix the sidebar',
        updatedAt: Date.now() - 1000,
      },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const painted = renderer.getPaintedText()
    expect(painted).toContain('Test Model A')
    expect(painted).toContain('Fix the sidebar')
    expect(painted).toContain('Today')
    expect(painted).toContain('alpha')
    expect(fake.calls.some((c) => c.method === 'getModels')).toBe(true)
    expect(fake.calls.some((c) => c.method === 'getProviders')).toBe(true)
  })

  it('creates a session on first send and streams the reply', async () => {
    const fake = new FakeEngine()
    fake.replyText = 'hello from the engine'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    expect(fake.calls.some((c) => c.method === 'newSession')).toBe(true)
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]!.prompt).toBe('hello')
    const painted = renderer.getPaintedText()
    expect(painted).toContain('hello')
    expect(painted).toContain('hello from the engine')
    expect(painted).toContain('Untitled session')
  })

  it('groups a reloaded turn into one fold, not one per tool call', () => {
    // A turn is one user prompt and everything the agent did in answer. Minting
    // a turn per tool-bearing message made "Worked for…" appear after every
    // individual call, and split one turn across several folds.
    const messages = [
      { id: 'u1', role: 'user' as const, content: 'write the script', turnId: 'r1' },
      { id: 'a1', role: 'assistant' as const, content: 'Writing it now.', turnId: 'r1' },
      {
        id: 'a2', role: 'assistant' as const, content: 'Saved.', turnId: 'r1',
        tools: [
          { id: 'a2-t0', name: 'bash', status: 'done' as const, turnId: 'r1', args: 'cat > x.sh' },
          { id: 'a2-t1', name: 'bash', status: 'done' as const, turnId: 'r1', args: 'bash -n x.sh' },
        ],
      },
      { id: 'u2', role: 'user' as const, content: 'now make it bigger', turnId: 'r2' },
      {
        id: 'a3', role: 'assistant' as const, content: 'Done.', turnId: 'r2',
        tools: [{ id: 'a3-t0', name: 'write', status: 'done' as const, turnId: 'r2' }],
      },
    ]
    const rows = deriveTimelineRows(messages, [])
    // One fold per turn, not per call.
    const folds = rows.filter((r) => r.kind === 'activity')
    expect(folds).toHaveLength(2)
    // The first turn carries both of its calls in one row.
    expect(folds[0]!.kind === 'activity' && folds[0]!.activities).toHaveLength(2)
    expect(activityDuration(folds[0]!.kind === 'activity' ? folds[0]!.activities : [])).toBe('2 tool calls')
    // The fold heads its turn: it comes before the turn's messages, and the
    // second turn's fold comes before that turn's prose rather than at the end
    // of the conversation.
    expect(rows.map((r) => r.key)).toEqual([
      'a:r1', 'm:u1', 'm:a1', 'm:a2',
      'a:r2', 'm:u2', 'm:a3',
    ])
  })

  it('renders tool calls in the fold', async () => {
    const fake = new FakeEngine()
    fake.toolScript = [{ name: 'read', output: 'contents' }]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    expect(renderer.getPaintedText()).toContain('Worked for 0 seconds')
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('work-fold-toggle').click()
      expect(renderer.getPaintedText()).toContain('read')
    } finally {
      await app.close()
    }
  })

  it('times a turn from the engine\'s span, not from its tool calls', async () => {
    // The engine's turn_start/turn_end bracket the model thinking before the
    // first call and the writing after the last. Here the tools all land inside
    // the same millisecond, so a shell that summed tool timings would print
    // "0 seconds" and one that adopted the engine's turn prints "2 seconds".
    // This is the assertion that fails if the turn id is not adopted.
    const fake = new FakeEngine()
    fake.toolScript = [{ name: 'read', output: 'contents' }]
    fake.turnTailDelayMs = 2_000
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await new Promise((resolve) => setTimeout(resolve, 2_200))
    await settle(renderer)

    expect(fake.turnIds).toEqual(['fake-turn-1'])
    expect(renderer.getPaintedText()).toContain('Worked for 2 seconds')
  })

  it('gives a turn that changed files a changes card, even when it succeeds', async () => {
    // The snapshot used to run only on the error path, so a turn that edited
    // files and then answered cleanly never got a receipt. It is driven by the
    // engine's turn_end, which is the one moment the tree still describes the
    // turn and nothing after it.
    const fake = new FakeEngine()
    fake.diff = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'fix it')
    await settle(renderer)

    expect(fake.calls.some((c) => c.method === 'getDiff')).toBe(true)
    expect(renderer.getPaintedText().join(' ')).toContain('1 changed files')
  })

  it('says why a send was refused instead of doing nothing', async () => {
    // The engine's send button becomes Stop while a turn runs, but Enter still
    // reaches send. That path used to return silently, so pressing Enter
    // mid-turn looked like the keyboard was broken.
    const fake = new FakeEngine()
    fake.pauseSend = true
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'first')
    await settle(renderer)

    typeSend(renderer, 'second')
    await settle(renderer)

    expect(fake.sent).toHaveLength(1)
    expect(renderer.getPaintedText().join(' ')).toContain('Wait for the current turn to finish')
  })

  it('surfaces engine send errors in the transcript', async () => {
    const fake = new FakeEngine()
    fake.sendError = 'provider exploded'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    expect(renderer.getPaintedText().some((line) => line.includes('provider exploded'))).toBe(
      true,
    )
  })

  it('shows a retryable banner when the engine is down', async () => {
    const fake = new FakeEngine()
    fake.failures = { getState: 'connection refused' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    expect(renderer.getPaintedText()).toContain('connection refused')
    const getStateCalls = () => fake.calls.filter((c) => c.method === 'getState').length
    const before = getStateCalls()
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('engine-retry').click()
      await settle(renderer)
      expect(getStateCalls()).toBeGreaterThan(before)
    } finally {
      await app.close()
    }
  })

  it('stops a running turn from the send button', async () => {
    const fake = new FakeEngine()
    fake.pauseSend = true
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('stop-message').click()
      expect(fake.stopped).toBe(true)
      fake.releaseSend()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('fake engine reply')
    } finally {
      await app.close()
    }
  })

  it('asks for approval and resumes on allow', async () => {
    const fake = new FakeEngine()
    fake.approvalScript = { toolCallId: 'tool-9', toolName: 'write' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    expect(renderer.getPaintedText()).toContain('Allow write?')
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('approval-allow').click()
      await settle(renderer)
      expect(fake.answeredApprovals).toEqual([{ toolCallId: 'tool-9', approved: true }])
      expect(renderer.getPaintedText()).toContain('fake engine reply')
      expect(renderer.getPaintedText()).not.toContain('Allow write?')
    } finally {
      await app.close()
    }
  })

  it('asks a question and sends the typed answer', async () => {
    const fake = new FakeEngine()
    fake.questionScript = { questionId: 'q-1', question: 'Which directory?' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    expect(renderer.getPaintedText()).toContain('Which directory?')
    const answer = renderer.findByTestId('question-answer')!
    renderer.nativeSimulateKeystrokes(answer.id, 's r c')
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('question-send').click()
      await settle(renderer)
      expect(fake.answeredQuestions).toEqual([{ questionId: 'q-1', answer: 'src' }])
    } finally {
      await app.close()
    }
  })

  it('switches sessions and loads their transcripts', async () => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const now = Date.now()
    const fake = new FakeEngine()
    fake.sessions = [
      { id: 's1', path: 'sess-1', cwd: '/Users/tester/projects/alpha', name: 'First', updatedAt: now },
      {
        id: 's2',
        path: 'sess-2',
        cwd: '/Users/tester/projects/alpha',
        name: 'Second',
        updatedAt: startOfDay.getTime() - 3600 * 1000,
      },
    ]
    fake.transcripts = {
      'sess-1': [{ id: 'm1', role: 'user', content: 'first question' }],
      'sess-2': [{ id: 'm2', role: 'user', content: 'second question' }],
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    expect(renderer.getPaintedText()).toContain('Yesterday')
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('thread-sess-2').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'getTranscriptPage' && c.args[0] === 'sess-2'),
      ).toBe(true)
      expect(renderer.getPaintedText()).toContain('second question')
    } finally {
      await app.close()
    }
  })

  it('walks thread history with the sidebar arrows', async () => {
    const now = Date.now()
    const fake = new FakeEngine()
    fake.sessions = [
      { id: 's1', path: 'sess-1', cwd: '/Users/tester/projects/alpha', name: 'First', updatedAt: now },
      { id: 's2', path: 'sess-2', cwd: '/Users/tester/projects/alpha', name: 'Second', updatedAt: now },
    ]
    fake.transcripts = {
      'sess-1': [{ id: 'm1', role: 'user', content: 'first question' }],
      'sess-2': [{ id: 'm2', role: 'user', content: 'second question' }],
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('thread-sess-1').click()
      await settle(renderer)
      // The session list is the way in, so it is also the way between sessions:
      // clicking the project you are already in returns to its list. Opening one
      // session directly from another is no longer a thing the UI offers.
      await app.getByTestId('sidebar-project-/Users/tester/projects/alpha').click()
      await settle(renderer)
      await app.getByTestId('thread-sess-2').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('second question')
      await app.getByTestId('history-back').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('first question')
      await app.getByTestId('history-forward').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('second question')
    } finally {
      await app.close()
    }
  })

  it('changes the model, reasoning, and approval through the engine', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('model-picker').click()
      await app.getByTestId('model-test-model-b').click()
      await settle(renderer)
      expect(fake.calls.some((c) => c.method === 'setModel' && c.args[0] === 'test-model-b')).toBe(
        true,
      )
      expect(renderer.getPaintedText()).toContain('Test Model B')

      await app.getByTestId('reasoning-picker').click()
      await app.getByTestId('reasoning-high').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'setThinkingLevel' && c.args[0] === 'high'),
      ).toBe(true)

      await app.getByTestId('access-trigger').click()
      await app.getByTestId('access-ask').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'setApprovalMode' && c.args[0] === 'ask'),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  // The footer's project chip is gone: the sidebar list is the switcher now, and
  // switching through it is covered by the sidebar project tests below.

  it('opens the diff overlay with parsed files and layouts', async () => {
    const fake = new FakeEngine()
    fake.diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' same',
      '-old',
      '+new',
    ].join('\n')
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('diff-toggle').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Uncommitted changes')
      expect(renderer.getPaintedText()).toContain('a.ts')

      await app.getByTestId('diff-layout-side-by-side').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Before')
      expect(renderer.getPaintedText()).toContain('After')
    } finally {
      await app.close()
    }
  })

  it('resizes both handles from the keyboard', async () => {
    const fake = new FakeEngine()
    // Enough files that the list is at its height cap. The list is
    // content-sized up to the cap, so with one file the cap is not binding and
    // raising it moves nothing — which is exactly how a test that cannot fail
    // gets written.
    const many = Array.from({ length: 40 }, (_, i) => ({
      path: `src/module-${i}.ts`,
      insertions: i + 1,
      deletions: 0,
      untracked: false,
    }))
    fake.vcs = {
      isRepo: true, refName: 'main', hasChanges: true,
      staged: [], unstaged: many,
      insertions: many.length, deletions: 0,
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('source-control-toggle').click()
      await settle(renderer)

      // Both handles are real separators, so they are reachable and operable
      // without a pointer.
      const width = renderer.findByTestId('git-resize-handle')
      const split = renderer.findByTestId('git-split-handle')
      expect(width).toBeDefined()
      expect(split).toBeDefined()
      // Keyboard resize must be able to move the panel, not just the pointer.
      // This used to press the keys and then assert the sidebar still existed,
      // which passes whether or not anything moved — and nothing did, because
      // the handlers compared against "arrowdown" where the platform sends
      // "down". So the geometry is asserted instead.
      const geometry = () => {
        const get = renderer as unknown as {
          getElementBounds: (id: number) => { x: number; y: number; width: number; height: number }
        }
        return {
          panel: get.getElementBounds(renderer.findByTestId('git-sidebar')!.id),
          split: get.getElementBounds(renderer.findByTestId('git-split-handle')!.id),
        }
      }

      const before = geometry()
      // The platform's spelling, not the DOM's.
      renderer.nativeSimulateKeyDown(renderer.findByTestId('git-split-handle')!.id, 'down')
      await settle(renderer)
      const afterSplit = geometry()
      expect(afterSplit.split.y).toBeGreaterThan(before.split.y)

      renderer.nativeSimulateKeyDown(renderer.findByTestId('git-resize-handle')!.id, 'right')
      await settle(renderer)
      const afterWidth = geometry()
      expect(afterWidth.panel.width).toBeGreaterThan(before.panel.width)
    } finally {
      await app.close()
    }
  })

  it('shows the selected file in the diff and clears back to the whole scope', async () => {
    const fake = new FakeEngine()
    fake.diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' same',
      '-alpha',
      '+beta',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1 +1 @@',
      '-gamma',
      '+delta',
    ].join('\n')
    fake.vcs = {
      isRepo: true, refName: 'main', hasChanges: true,
      staged: [],
      unstaged: [
        { path: 'a.ts', insertions: 1, deletions: 1, untracked: false },
        { path: 'b.ts', insertions: 1, deletions: 1, untracked: false },
      ],
      insertions: 2, deletions: 2,
    }
    // The viewer asks the engine for the selected file rather than slicing the
    // tree diff, which is what makes selection work on a large change set.
    fake.fileDiffs = { 'b.ts': fake.diff.split('diff --git a/b.ts b/b.ts')[1] ?? '' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('source-control-toggle').click()
      await settle(renderer)

      // The list is a single scroll container with a draggable split.
      expect(renderer.findByTestId('git-section-unstaged-list')).toBeDefined()
      expect(renderer.findByTestId('git-split-handle')).toBeDefined()

      // Nothing selected yet: the viewer shows the whole scope.
      expect(renderer.findByTestId('git-diff-file-bar')).toBeUndefined()

      // Selecting a row narrows the viewer to that file, and says which.
      await app.getByTestId('git-file-b.ts').click()
      await settle(renderer)
      // The engine was asked for that one file specifically.
      const asked = fake.calls.filter(c => c.method === 'vcsFileDiff')
      expect(asked).toHaveLength(1)
      expect(asked[0]!.args[0]).toBe('b.ts')
      // No duplicate file-name bar: <diff> draws its own header for the patch.
      expect(renderer.findByTestId('git-diff-file-bar')).toBeUndefined()
      // The clear control moves into the scope bar instead.
      expect(renderer.findByTestId('git-diff-file-clear')).toBeDefined()

      // Selecting a second file refetches rather than reusing the first.
      await app.getByTestId('git-file-a.ts').click()
      await settle(renderer)
      const asked2 = fake.calls.filter(c => c.method === 'vcsFileDiff')
      expect(asked2).toHaveLength(2)
      expect(asked2[1]!.args[0]).toBe('a.ts')

      // Clearing returns to the whole scope.
      await app.getByTestId('git-diff-file-clear').click()
      await settle(renderer)
      expect(renderer.findByTestId('git-diff-file-clear')).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('shows a status row while a turn is in flight and clears it after', async () => {
    const fake = new FakeEngine()
    // The turn is held open so the row can be observed mid-flight; it settles
    // instantly otherwise, and there would be nothing to see.
    fake.pauseSend = true
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      // Mid-turn the row is present, and says the agent is working.
      expect(renderer.findByTestId('agent-status')).toBeDefined()
      const mid = renderer.getPaintedText().join(' ')
      expect(mid).toMatch(/Thinking…|Writing…|read file…|bash…/)

      // Once the turn settles, nothing is left claiming to be working.
      fake.releaseSend()
      await settle(renderer)
      expect(renderer.findByTestId('agent-status')).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('copies a response and a code block through the engine', async () => {
    // The clipboard has no GPUIX or DOM API, so the engine performs the write.
    // Both controls must reach it, and with the right text.
    const fake = new FakeEngine()
    fake.replyText = 'The fix is one line.\n\n```ts\nconst a = 1\n```'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      // The response copy control copies the markdown, not the rendered text.
      await app.getByTestId('copy-response').click()
      await settle(renderer)
      expect(fake.copied).toHaveLength(1)
      expect(fake.copied[0]).toContain('The fix is one line.')
      expect(fake.calls.some((c) => c.method === 'copyToClipboard')).toBe(true)

      // Every code block carries its own copy control.
      expect(renderer.findByTestId('copy-code')).toBeDefined()
      await app.getByTestId('copy-code').click()
      await settle(renderer)
      expect(fake.copied).toHaveLength(2)
      // The code is copied verbatim, without the fence or the line numbers.
      expect(fake.copied[1]).toContain('const a = 1')
      expect(fake.copied[1]).not.toContain('```')
    } finally {
      await app.close()
    }
  })

  it('parses a transcript page with tool calls without throwing', () => {
    // The parser folded results into their call by reading the accumulator
    // from inside the pass that built it — a temporal dead zone. It threw
    // "Cannot access 'messages' before initialization" on every session load,
    // and shipped because the parse lived inside the client and no test
    // reached it. It is extracted now so this can.
    const page = parseTranscriptPage({
      hasMore: false,
      earliestId: 'e0',
      entries: [
        { id: 'e1', message: { role: 'user', content: [{ type: 'text', text: 'run it' }] } },
        {
          id: 'e2',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Running it.' },
              { type: 'toolCall', name: 'bash', arguments: { command: 'cat file.txt' } },
            ],
          },
        },
        {
          id: 'e3',
          message: {
            role: 'toolResult',
            toolName: 'bash',
            toolCallId: 'e2',
            content: [{ type: 'text', text: 'hello' }],
          },
        },
      ],
    })
    // The result folded into the message holding the call.
    expect(page.messages).toHaveLength(2)
    const answer = page.messages[1]!
    expect(answer.content).toBe('Running it.')
    // No tool text leaked into the prose.
    expect(answer.content).not.toContain('[tool]')
    expect(answer.content).not.toContain('hello')
    // The call carries its args, and the result its output.
    expect(answer.tools).toHaveLength(2)
    expect(answer.tools![0]).toMatchObject({ name: 'bash', args: 'cat file.txt' })
    expect(answer.tools![1]).toMatchObject({ name: 'bash', output: 'hello', status: 'done' })
  })

  it('parses an empty and a malformed page without throwing', () => {
    expect(parseTranscriptPage(null).messages).toEqual([])
    expect(parseTranscriptPage({}).messages).toEqual([])
    expect(parseTranscriptPage({ entries: 'nope' }).messages).toEqual([])
    expect(parseTranscriptPage({ entries: [{ id: 'x' }] }).messages).toEqual([])
  })

  it('renders reloaded tool calls as rows, not as transcript prose', () => {
    // A stored page used to splice "[tool] bash\n<output>" into the message
    // text, so a reloaded turn rendered a tool log in the assistant's voice,
    // styled as prose by the markdown renderer.
    const rows = deriveTimelineRows(
      [
        { id: 'u1', role: 'user', content: 'run it' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Here is the result.',
          turnId: 'r1',
          tools: [{
            id: 'a1-t0', name: 'bash', status: 'done',
            turnId: 'r1', args: 'cat file.txt', output: 'hello',
          }],
        },
      ],
      [],
    )
    // The prose is only the model's sentence.
    const message = rows.find((r) => r.kind === 'message' && r.message.id === 'a1')
    expect(message?.kind === 'message' && message.message.content).toBe('Here is the result.')
    expect(JSON.stringify(message)).not.toContain('[tool]')
    // And the call is a folded activity row carrying its args.
    const activity = rows.find((r) => r.kind === 'activity')
    expect(activity?.kind === 'activity' && activity.activities[0]?.name).toBe('bash')
    expect(activity?.kind === 'activity' && activity.activities[0]?.args).toBe('cat file.txt')
  })

  it('records nothing as copied when the clipboard write failed', async () => {
    // A stale engine rejects copy_to_clipboard. A copy control that says
    // "Copied" anyway is worse than one that says nothing, because the user
    // pastes stale content believing it is current.
    const fake = new FakeEngine()
    fake.replyText = 'A response body.'
    fake.failCopyWith = 'unknown command: copy_to_clipboard'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('copy-response').click()
      await settle(renderer)
      // The write was attempted and failed, so nothing was recorded as copied.
      expect(fake.calls.some((c) => c.method === 'copyToClipboard')).toBe(true)
      expect(fake.copied).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it('turns ANSI escapes into colour instead of printing them', () => {
    // The exact shape a model emits when asked for terminal colour.
    const src = '\u001b[1;97mBOLD\u001b[0m plain \u001b[31mred\u001b[0m'
    const runs = parseAnsi(src)
    // The escape characters are gone, not painted.
    expect(runs.map((r) => r.text).join('')).toBe('BOLD plain red')
    expect(runs.some((r) => r.text.includes('\u001b'))).toBe(false)
    // Bold survived, and the plain run is not bold.
    expect(runs[0]!.bold).toBe(true)
    expect(runs.find((r) => r.text === ' plain ')?.bold).toBeUndefined()
    // A red run got a real colour.
    expect(runs.find((r) => r.text === 'red')?.color).toBeTruthy()
  })

  it('handles the literal "x1b[" form a model actually emits', () => {
    // A real transcript contained the text `x1b[1;97m`, not an ESC byte — the
    // escape had already been escaped somewhere upstream. Parsing only real
    // ESC bytes would paint that as visible garbage, which is the bug.
    const src = 'x1b[1;97mLOREM IPSUMx1b[0m'
    expect(hasAnsi(src)).toBe(true)
    const runs = parseAnsi(src)
    expect(runs.map((r) => r.text).join('')).toBe('LOREM IPSUM')
    expect(runs.some((r) => r.text.includes('x1b'))).toBe(false)
    expect(runs[0]!.bold).toBe(true)
    // A plain source is left completely alone.
    expect(hasAnsi('no escapes here')).toBe(false)
    expect(parseAnsi('no escapes here')).toEqual([{ text: 'no escapes here' }])
  })

  it('passes through a source with no escapes untouched', () => {
    expect(parseAnsi('just text')).toEqual([{ text: 'just text' }])
  })

  it('drops non-colour escapes rather than printing them', () => {
    // Cursor moves and erases are noise in a transcript.
    const runs = parseAnsi('\u001b[2J\u001b[Hvisible')
    expect(runs.map((r) => r.text).join('')).toBe('visible')
  })

  it('handles 256-colour and truecolour forms', () => {
    const runs256 = parseAnsi('\u001b[38;5;196mred\u001b[0m')
    expect(runs256[0]!.text).toBe('red')
    expect(runs256[0]!.color).toMatch(/^#/)
    const runsTrue = parseAnsi('\u001b[38;2;255;0;0mred\u001b[0m')
    expect(runsTrue[0]!.color).toMatch(/^#/)
  })

  it('never loses text when escapes are interleaved', () => {
    const src = 'a\u001b[1mb\u001b[0mc\u001b[32md\u001b[0me'
    expect(parseAnsi(src).map((r) => r.text).join('')).toBe('abcde')
  })

  it('renders unparseable markdown as text instead of crashing the window', async () => {
    // MDX treats an unclosed inline tag as a hard error. A streaming answer is
    // a partial document by definition, so this is expected traffic — it must
    // degrade to plain text, not throw out of render and blank the app.
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<SafeMdxContent onCopy={async () => {}} source='text <span class="x broken' />)
    await settle(renderer)
    expect(renderer.getPaintedText().join(' ')).toContain('broken')

    // A well-formed document still renders as markdown, not the fallback.
    const second = createTestRoot()
    second.render(<SafeMdxContent onCopy={async () => {}} source="A **bold** word" />)
    await settle(second.renderer)
    expect(second.renderer.getPaintedText().join(' ')).toContain('bold')
  })

  it('never cuts inside a tag, a fence, or an HTML construct', () => {
    // Cutting mid-tag hands the markdown parser half a `<span …`, which throws
    // and used to take down the whole window mid-stream.
    const cases: Array<[string, string]> = [
      ['inline html', 'A note with <span style="color:red">emphasis here</span>.\n\nNext para.'],
      ['fenced code', 'Intro.\n\n```ts\nconst a = 1\nconst b = 2\n```\n\nAfter the fence.'],
      ['inline code', 'Use `const a = 1` here.\n\nNext.'],
      ['bold', 'This is **bold** text.\n\nNext para.'],
      ['list', 'Items:\n\n- one\n- two\n\nAfter.'],
    ]
    for (const [name, text] of cases) {
      const out: string[] = []
      const s = createBlockStreamer((c) => out.push(c), { now: () => 0 })
      // Per-character, as the engine delivers it.
      for (const ch of text) s.push(ch)
      s.flush()
      // Text is never lost or reordered, whatever the cut points.
      expect(out.join('')).toBe(text)
      // No chunk ends mid-tag. These documents are well formed throughout, so
      // every chunk — including the last — must be clean.
      for (const chunk of out) {
        const before = chunk.slice(0, -1)
        expect(before.lastIndexOf('<') > before.lastIndexOf('>')).toBe(false)
      }
      // More than one paint, so this is genuinely streamed in blocks.
      expect(out.length).toBeGreaterThan(1)
    }
  })

  it('does not release a mid-tag boundary, and never drops the tail', () => {
    // A blank line arrives while the tag is still open, which is the exact
    // shape that produced "Expected a closing tag for <span> (4:102-4:130)".
    const text = 'A note <span class="x\n\nmore text'
    const out: string[] = []
    const s = createBlockStreamer((c) => out.push(c), { now: () => 0 })
    for (const ch of text) s.push(ch)
    s.flush()
    // On settle the held text is emitted in full. Losing it would be worse
    // than a document that needs the plain-text fallback — and this proves the
    // unsafe boundary did not lose the text it was protecting. How many chunks
    // that takes depends on the real clock: with a frozen clock it is one, and
    // under load the time budget can release the held prefix first.
    expect(out.join('')).toBe(text)
    expect(out.length).toBeGreaterThan(0)
  })

  it('holds a block rather than emitting half a tag', () => {
    const out: string[] = []
    const s = createBlockStreamer((c) => out.push(c), { now: () => 0 })
    // The blank line lands while the tag is still open — the exact shape that
    // produced "Expected a closing tag for <span> (4:102-4:130)".
    const text = 'text <span class="x\n\nmore'
    for (const ch of text) s.push(ch)
    // The blank line is a boundary, but cutting there would hand the parser
    // `<span class="x`, so it is held rather than released.
    s.flush()
    // Nothing is dropped: the tail is emitted even though it ends mid-tag,
    // because losing text is worse than a document that needs the plain-text
    // fallback. That fallback is the real guarantee against this crash.
    expect(out.join('')).toBe(text)
  })

  it('reports what the agent is doing, from real events', () => {
    // A turn that has started but produced nothing is thinking.
    let s = reduceAgentStatus({ kind: 'idle' }, new Set(), { kind: 'started' })
    expect(s.status).toEqual({ kind: 'thinking' })

    // Text means it is writing.
    s = reduceAgentStatus(s.status, s.running, { kind: 'text_delta', text: 'hi' })
    expect(s.status).toEqual({ kind: 'writing' })

    // A tool in flight names the tool, over the writing state.
    s = reduceAgentStatus(s.status, s.running, {
      kind: 'tool_start', toolCallId: 't1', toolName: 'read_file',
    })
    expect(s.status).toEqual({ kind: 'tool', tool: 'read_file' })

    // Text while the tool runs does not overwrite the tool state.
    s = reduceAgentStatus(s.status, s.running, { kind: 'text_delta', text: 'more' })
    expect(s.status).toEqual({ kind: 'tool', tool: 'read_file' })

    // The tool finishing returns to writing.
    s = reduceAgentStatus(s.status, s.running, {
      kind: 'tool_end', toolCallId: 't1', toolName: 'read_file', output: '', isError: false,
    })
    expect(s.status).toEqual({ kind: 'writing' })

    // Settling clears it, so the row disappears.
    s = reduceAgentStatus(s.status, s.running, { kind: 'settled', reason: 'done' })
    expect(s.status).toEqual({ kind: 'idle' })
    expect(s.running.size).toBe(0)
  })

  it('keeps naming a tool while others are still running', () => {
    let s = reduceAgentStatus({ kind: 'idle' }, new Set(), { kind: 'started' })
    s = reduceAgentStatus(s.status, s.running, { kind: 'tool_start', toolCallId: 'a', toolName: 'read' })
    s = reduceAgentStatus(s.status, s.running, { kind: 'tool_start', toolCallId: 'b', toolName: 'write' })
    expect(s.status).toEqual({ kind: 'tool', tool: 'write' })
    s = reduceAgentStatus(s.status, s.running, { kind: 'tool_end', toolCallId: 'b', toolName: 'write', output: '', isError: false })
    // One is still in flight, so it is still a tool state, not writing.
    expect(s.status.kind).toBe('tool')
  })

  it('surfaces compaction as its own state', () => {
    let s = reduceAgentStatus({ kind: 'writing' }, new Set(), { kind: 'compaction_start', reason: 'auto' })
    expect(s.status).toEqual({ kind: 'compacting' })
    s = reduceAgentStatus(s.status, s.running, { kind: 'compaction_end', reason: 'auto', summary: 'x' })
    expect(s.status).toEqual({ kind: 'idle' })
  })

  it('labels each status, and nothing when idle', () => {
    expect(agentStatusLabel({ kind: 'idle' })).toBe('')
    expect(agentStatusLabel({ kind: 'thinking' })).toBe('Thinking…')
    expect(agentStatusLabel({ kind: 'writing' })).toBe('Writing…')
    expect(agentStatusLabel({ kind: 'compacting' })).toBe('Compacting context…')
    // Tool names are snake_case from the engine; a space reads better.
    expect(agentStatusLabel({ kind: 'tool', tool: 'read_file' })).toBe('read file…')
  })

  it('streams whole blocks rather than one character at a time', () => {
    const out: string[] = []
    // A frozen clock isolates the boundary rule from the time budget, which is
    // exercised on its own below.
    const s = createBlockStreamer((c) => out.push(c), { now: () => 0 })

    // Feed a paragraph one character at a time, exactly as the engine does,
    // stopping short of its blank line.
    const partial = 'The fix is one line.'
    for (const ch of partial) s.push(ch)

    // Mid-paragraph nothing is painted: a partial word is never on screen.
    expect(out).toEqual([])

    // The blank line closes the block, and it appears in one piece.
    s.push('\n\n')
    expect(out).toEqual(['The fix is one line.\n\n'])
  })

  it('releases a heading as one block', () => {
    const out: string[] = []
    const s = createBlockStreamer((c) => out.push(c), { now: () => 0 })
    for (const ch of '## The fix\n\nBody text.') s.push(ch)
    // The heading has its own boundary, so it lands as soon as its newline
    // arrives — without waiting for the blank line after it.
    expect(out).toEqual(['## The fix\n'])
    // The body is still buffered; it is not painted as a growing line.
    expect(out.join('')).not.toContain('Body')
  })

  it('flushes the tail on settle so no text is lost', () => {
    const out: string[] = []
    const s = createBlockStreamer((c) => out.push(c))
    for (const ch of 'A paragraph with no trailing blank line.') s.push(ch)
    // Still buffered: no boundary arrived.
    expect(out).toEqual([])
    s.flush()
    expect(out.join('')).toBe('A paragraph with no trailing blank line.')
  })

  it('preserves the full text across arbitrary chunking', () => {
    // The engine's real chunking is neither per character nor block-aligned.
    const full =
      '## Heading\n\nFirst paragraph with `code`.\n\n' +
      '- bullet one\n- bullet two\n\nLast line, no trailing break.'
    for (const size of [1, 3, 7, 40]) {
      const out: string[] = []
      const s = createBlockStreamer((c) => out.push(c))
      for (let i = 0; i < full.length; i += size) s.push(full.slice(i, i + size))
      s.flush()
      // Whatever the chunk size, the reader sees the same text.
      expect(out.join('')).toBe(full)
      // And it is delivered in more than one paint, never as one giant blob
      // only when the sizes are small.
      if (size === 1) expect(out.length).toBeGreaterThan(1)
    }
  })

  it('releases a long paragraph on the time budget instead of stalling', () => {
    const out: string[] = []
    let clock = 0
    const s = createBlockStreamer(
      (c) => out.push(c),
      { maxDelayMs: 100, now: () => clock },
    )
    // One enormous paragraph, no blank line in sight, arriving slowly.
    for (let i = 0; i < 20; i++) {
      clock += 30
      s.push('word ')
    }
    // The time budget fired, so the reader is not staring at nothing.
    expect(out.join('')).toContain('word')
    s.flush()
  })

  it('fetches a file diff once per selection, not once per render', async () => {
    // The caller passes an inline arrow, so its identity changed every render.
    // As a useEffect dependency that re-ran the fetch, which set state, which
    // re-rendered — an endless loop that read as a flickering diff.
    const fake = new FakeEngine()
    fake.diff = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b'
    fake.vcs = {
      isRepo: true, refName: 'main', hasChanges: true,
      staged: [], unstaged: [{ path: 'a.ts', insertions: 1, deletions: 1, untracked: false }],
      insertions: 1, deletions: 1,
    }
    fake.fileDiffs = { 'a.ts': fake.diff }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('source-control-toggle').click()
      await settle(renderer)
      await app.getByTestId('git-file-a.ts').click()
      await settle(renderer)
      // One selection means one fetch.
      //
      // NOTE: this cannot detect the render loop on its own. Reinstating the
      // unstable dependency still passes here, because the test renderer does
      // not re-render on the same schedule as the live app. The guarantee is
      // structural — the effect depends only on `selectedPath`, and the
      // callback is read through a ref — so it holds regardless of re-renders.
      const afterSettle = fake.calls.filter(c => c.method === 'vcsFileDiff').length
      expect(afterSettle).toBe(1)
    } finally {
      await app.close()
    }
  })

  it('keeps a large file list scrollable instead of pushing the diff away', async () => {
    // 49 files used to grow the section to the full panel height, which shoved
    // the commit box and the diff off-screen with no way to reach them.
    const many = Array.from({ length: 49 }, (_, i) => ({
      path: `assets/icons/icon-${i}.svg`, insertions: 1, deletions: 0, untracked: true,
    }))
    const fake = new FakeEngine()
    fake.vcs = {
      isRepo: true, refName: 'main', hasChanges: true,
      staged: [], unstaged: many, insertions: 49, deletions: 0,
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('source-control-toggle').click()
      await settle(renderer)

      // The list exists and holds every row.
      const list = renderer.findByTestId('git-section-unstaged-list')
      expect(list).toBeDefined()
      expect(renderer.findByTestId('git-file-assets/icons/icon-48.svg')).toBeDefined()

      // NOTE: the test renderer has no real layout, so a height assertion here
      // cannot fail and would claim verification it does not have. What is
      // verifiable is that the rows live inside a dedicated scroll container
      // rather than expanding the section directly.
    } finally {
      await app.close()
    }
  })

  it('opens Source Control from a permanent control, not just the branch chip', async () => {
    // The branch chip only renders on a real branch, and a turn's "Open diff"
    // only exists after the agent edits something. On a clean tree, a detached
    // HEAD, or a fresh project neither is reachable, so the panel used to be
    // unreachable exactly when a user most wants it.
    const fake = new FakeEngine()
    fake.vcs = {
      isRepo: true, refName: '', hasChanges: false,
      staged: [], unstaged: [], insertions: 0, deletions: 0,
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    // No branch, so the chip is absent — but the control must still be there.
    expect(renderer.findByTestId('header-git')).toBeUndefined()
    const app = await connectTest(renderer)
    try {
      const toggle = renderer.findByTestId('source-control-toggle')
      expect(toggle).toBeDefined()
      await app.getByTestId('source-control-toggle').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Source Control')
      // A clean tree says so rather than showing an empty diff.
      expect(renderer.getPaintedText()).toContain('Nothing to commit.')
    } finally {
      await app.close()
    }
  })

  it('says so when the project is not a git repository', async () => {
    const fake = new FakeEngine()
    fake.vcs = {
      isRepo: false, refName: '', hasChanges: false,
      staged: [], unstaged: [], insertions: 0, deletions: 0,
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('source-control-toggle').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Not a git repository')
      // No diff viewer: an empty one would read as "no changes".
      expect(renderer.findByTestId('git-diff-body')).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('stages a file and commits it through the engine', async () => {
    const fake = new FakeEngine()
    fake.diff = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b'
    fake.vcs = {
      isRepo: true, refName: 'main', hasChanges: true,
      staged: [],
      unstaged: [{ path: 'a.ts', insertions: 1, deletions: 1, untracked: false }],
      insertions: 1, deletions: 1,
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('header-git').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Changes')
      expect(renderer.getPaintedText()).toContain('a.ts')

      // Staging goes through the engine, and the whole tree is re-read after.
      await app.getByTestId('git-file-action-a.ts').click()
      await settle(renderer)
      const staged = fake.calls.filter(c => c.method === 'vcsStage')
      expect(staged).toHaveLength(1)
      expect(staged[0]!.args[0]).toEqual(['a.ts'])

      // The fake now reports the file as staged, so the commit affordance opens.
      // Status is only re-read on refresh, which is what the real engine does
      // after a mutation.
      fake.vcs = { ...fake.vcs, staged: [{ path: 'a.ts', insertions: 1, deletions: 1, untracked: false }], unstaged: [] }
      await app.getByTestId('git-refresh').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Staged')
      expect(renderer.getPaintedText()).toContain('Commit staged changes')
      await app.getByTestId('git-commit-open').click()
      await settle(renderer)
      await app.getByTestId('git-commit-message').fill('update a')
      await app.getByTestId('git-commit-submit').click()
      await settle(renderer)

      const commits = fake.calls.filter(c => c.method === 'vcsCommit')
      expect(commits).toHaveLength(1)
      expect(commits[0]!.args[0]).toBe('update a')
    } finally {
      await app.close()
    }
  })

  it('surfaces a failed git action instead of silently doing nothing', async () => {
    const fake = new FakeEngine()
    fake.vcs = {
      isRepo: true, refName: 'main', hasChanges: true,
      staged: [{ path: 'a.ts', insertions: 1, deletions: 0, untracked: false }],
      unstaged: [], insertions: 1, deletions: 0,
    }
    fake.failVcsWith = 'fatal: could not lock ref'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('header-git').click()
      await settle(renderer)
      await app.getByTestId('git-section-staged-all').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Git action failed')
      expect(renderer.getPaintedText()).toContain('fatal: could not lock ref')
    } finally {
      await app.close()
    }
  })

  it('explains why committing is unavailable', () => {
    const clean: VcsStatus = {
      isRepo: true, refName: 'main', hasChanges: false,
      staged: [], unstaged: [], insertions: 0, deletions: 0,
    }
    expect(commitBlockedReason(clean)).toBe('Nothing to commit.')

    const unstagedOnly: VcsStatus = {
      ...clean, hasChanges: true,
      unstaged: [{ path: 'a.ts', insertions: 1, deletions: 0, untracked: false }],
    }
    expect(commitBlockedReason(unstagedOnly)).toBe('Stage at least one file to commit.')

    const staged: VcsStatus = { ...clean, hasChanges: true, staged: unstagedOnly.unstaged }
    expect(commitBlockedReason(staged)).toBeNull()

    const notARepo: VcsStatus = { ...clean, isRepo: false }
    expect(commitBlockedReason(notARepo)).toBe('This folder is not a git repository.')
  })

  it('gives the sidebar diff a bounded height so it paints', async () => {
    // <diff scroll> is a virtualized scroller that renders nothing without a
    // bounded height. The height must be on the <diff> element itself, not on a
    // wrapper — a wrapper leaves the native element with no viewport and the
    // pane comes up blank. This asserts the element is mounted and measurable.
    const fake = new FakeEngine()
    fake.diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,2 @@',
      ' same',
      '-old',
      '+new',
    ].join('\n')
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('header-git').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Working tree')
      const body = renderer.findByTestId('git-diff-body')
      expect(body).toBeDefined()
      // Assert geometry, not just presence: an unbounded <diff scroll> mounts but
      // paints nothing, which is the blank-pane bug. A bounded one has real size.
      const bounds = renderer.getElementBounds(body!.id)
      expect(bounds).not.toBeNull()
      expect(bounds!.width).toBeGreaterThan(0)
      expect(bounds!.height).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  it('selects message text in a user turn', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)

    const bubble = renderer.findByTestId('user-turn')
    expect(bubble).toBeDefined()
    const box = renderer.getElementBounds(bubble!.id)
    expect(box).not.toBeNull()
    const selected = renderer.dragSelect(
      box!.x + 4,
      box!.y + box!.height / 2,
      box!.x + box!.width - 4,
      box!.y + box!.height / 2,
    )
    expect(selected).not.toBeNull()
    expect(selected).toContain('hello')
    expect(selected).not.toContain('Do anything...')
  })

  it('filters threads from the search overlay', async () => {
    const fake = new FakeEngine()
    fake.sessions = [
      {
        id: 's1',
        path: 'sess-1',
        cwd: '/Users/tester/projects/alpha',
        name: 'Fix the sidebar',
        updatedAt: Date.now(),
      },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('search').click()
      expect(renderer.getPaintedText()).toContain('Search threads')
      expect(renderer.getFocusedElementId()).toBe(renderer.findByTestId('search-input')?.id)

      renderer.nativeSimulateClick(900, 40)
      expect(renderer.getPaintedText()).not.toContain('Search threads')
    } finally {
      await app.close()
    }
  })

  it('focuses the composer after New Task and thread switches', async () => {
    const fake = new FakeEngine()
    fake.sessions = [
      {
        id: 's1',
        path: 'sess-1',
        cwd: '/Users/tester/projects/alpha',
        name: 'First',
        updatedAt: Date.now(),
      },
    ]
    fake.transcripts = { 'sess-1': [{ id: 'm1', role: 'user', content: 'first question' }] }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('new-task').click()
      const composer = renderer.findByTestId('composer')
      expect(composer).toBeDefined()
      expect(renderer.getFocusedElementId()).toBe(composer?.id)

      await app.getByTestId('thread-sess-1').click()
      expect(renderer.getFocusedElementId()).toBe(renderer.findByTestId('composer')?.id)
    } finally {
      await app.close()
    }
  })

  it('keeps transcript rows when the sidebar collapses', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'alpha')
    await settle(renderer)
    const before = renderer.findByType('virtual-list')[0]?.children.slice() ?? []
    expect(before.length).toBeGreaterThan(0)

    const app = await connectTest(renderer)
    await app.getByTestId('sidebar-collapse').click()

    expect(renderer.findByType('virtual-list')[0]?.children).toEqual(before)
    expect(await app.getByTestId('sidebar-expand').count()).toBe(1)
  })

  it('stays painted after render() remounts the tree', async () => {
    resetRender()
    const renderer = new TestRenderer()
    const before = path.join(SHOTS, 'chat-remount-before.png')
    const after = path.join(SHOTS, 'chat-remount-after.png')
    const fake = new FakeEngine()

    render(<ChatApp client={fake} />, { renderer, width: 1180, height: 820 })
    renderer.flush()
    renderer.captureScreenshot(before)
    // The sidebar actions are icon-only and the composer placeholder changes
    // with engine state, so the approval control is the stable thing that says
    // the chat screen is on screen.
    expect(renderer.getPaintedText()).toContain('Auto-approve')

    render(<ChatApp client={fake} />, { renderer, width: 1180, height: 820 })
    renderer.flush()
    await new Promise((resolve) => setTimeout(resolve, 50))
    renderer.flush()
    renderer.captureScreenshot(after)

    expect(renderer.getRoot()).toBeDefined()
    expect(renderer.getPaintedText()).toContain('Auto-approve')
    expect(fs.statSync(after).size).toBeGreaterThan(0)
  }, 20_000)

  it('captures the top screenshot', async () => {
    const top = path.join(SHOTS, 'chat-top.png')
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    renderer.captureScreenshot(top)
    expect(fs.statSync(top).size).toBeGreaterThan(0)
  })
})

describeNative('settings screen', () => {
  it('navigates sections and returns to chat', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      expect(renderer.getPaintedText()).toContain('General')
      expect(renderer.getPaintedText()).toContain('Follow-up behavior')
      expect(renderer.getPaintedText()).toContain('Text generation model')

      await app.getByTestId('settings-nav-appearance').click()
      expect(renderer.getPaintedText()).toContain('Appearance')
      expect(renderer.getPaintedText()).toContain('Interface font')
      expect(renderer.getPaintedText()).toContain('Monospace font')

      await app.getByTestId('settings-nav-providers').click()
      expect(renderer.getPaintedText()).toContain('Providers')
      expect(renderer.getPaintedText()).toContain('Codex')
      expect(renderer.getPaintedText()).toContain('OpenCode Go')

      await app.getByTestId('settings-back').click()
      expect(renderer.getPaintedText()).toContain('Do anything...')
      expect(renderer.getPaintedText()).not.toContain('Follow-up behavior')
    } finally {
      await app.close()
    }
  })

  it('switches the theme live and restores defaults', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const rootBg = () =>
      String(renderer.getElement(renderer.findByTestId('app-root')!.id)?.style.backgroundColor ?? '')

    const app = await connectTest(renderer)
    try {
      expect(rootBg()).toBe('#1C1916')
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-theme').click()
      expect(renderer.getPaintedText()).toContain('Midnight')
      await app.getByTestId('settings-theme-midnight').click()
      await settle(renderer)
      expect(rootBg()).toBe('#0B0E14')

      await app.getByTestId('settings-restore').click()
      await settle(renderer)
      expect(rootBg()).toBe('#1C1916')
    } finally {
      await app.close()
    }
  })

  it('applies the interface font live', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const rootFont = () =>
      String(renderer.getElement(renderer.findByTestId('app-root')!.id)?.style.fontFamily ?? '')

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-sans').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Filter fonts')
      const search2 = renderer.findByTestId('settings-sans-search')!
      renderer.nativeSimulateKeystrokes(search2.id, 'v e r')
      await settle(renderer)
      await app.getByTestId('settings-sans-option-Verdana').click()
      await settle(renderer)
      expect(rootFont()).toBe('Verdana')
      expect(renderer.getPaintedText()).not.toContain('Filter fonts')
    } finally {
      await app.close()
    }
  })

  it('saves and removes provider keys through the engine', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-providers').click()

      const key = renderer.findByTestId('settings-zen-key')!
      renderer.nativeSimulateKeystrokes(key.id, 'z e n - k e y')
      await app.getByTestId('settings-zen-connect').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'setApiKey' && c.args[0] === 'opencode-zen'),
      ).toBe(true)
      expect(renderer.getPaintedText()).toContain('Connected')

      await app.getByTestId('settings-zen-disconnect').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'removeApiKey' && c.args[0] === 'opencode-zen'),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('saves a custom endpoint and switches the default provider', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-providers').click()

      const url = renderer.findByTestId('settings-endpoint-url')!
      renderer.nativeSimulateKeystrokes(url.id, 'h t t p s : / / r e l a y')
      const key = renderer.findByTestId('settings-endpoint-key')!
      renderer.nativeSimulateKeystrokes(key.id, 's e c r e t')
      await app.getByTestId('settings-endpoint-save').click()
      await settle(renderer)
      expect(fake.calls.some((c) => c.method === 'setApiEndpoint')).toBe(true)

      await app.getByTestId('settings-default-provider').click()
      await app.getByTestId('settings-default-provider-codex').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'setProvider' && c.args[0] === 'codex'),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('shows the codex login command instead of a fake oauth button', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-providers').click()
      expect(
        renderer.getPaintedText().some((line) => line.includes('escape login codex')),
      ).toBe(true)
      expect(renderer.getPaintedText()).not.toContain('Connect with OAuth')
    } finally {
      await app.close()
    }
  })

  it('drives follow-up modes and the title model through the engine', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-follow-up').click()
      await app.getByTestId('settings-follow-up-steer').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'setSteeringMode' && c.args[0] === 'all'),
      ).toBe(true)
      expect(
        fake.calls.some((c) => c.method === 'setFollowUpMode' && c.args[0] === 'all'),
      ).toBe(true)

      await app.getByTestId('settings-text-model').click()
      await app.getByTestId('settings-text-model-test-model-b').click()
      await settle(renderer)
      expect(
        fake.calls.some((c) => c.method === 'setTitleModel' && c.args[0] === 'test-model-b'),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('repaints mono previews when the monospace font changes', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot({ width: 1280, height: 1400 })
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const shot = (name: string): Buffer => {
      const out = path.join(SHOTS, `mono-${name}.png`)
      renderer.captureScreenshot(out)
      return fs.readFileSync(out)
    }
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      const before = shot('before')
      await app.getByTestId('settings-mono').click()
      await app.getByTestId('settings-mono-option-Courier New').click()
      await settle(renderer)
      expect(shot('after').equals(before)).toBe(false)
    } finally {
      await app.close()
    }
  })
  it('changes general preferences from their dropdowns', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-diff-layout').click()
      await app.getByTestId('settings-diff-layout-side-by-side').click()
      await settle(renderer)
      expect(renderer.getPaintedText()).toContain('Side by side')
    } finally {
      await app.close()
    }
  })

  it('renders live typography previews', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      expect(renderer.getPaintedText()).toContain('Frontend Design')
      expect(
        renderer.getPaintedText().some((line) => line.includes('formatUser')),
      ).toBe(true)
      expect(
        renderer.getPaintedText().some((line) => line.includes('watching for changes')),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('scales the interface size live', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const composerSize = () =>
      renderer.findByType('textarea')[0]?.style.fontSize as number | undefined

    const app = await connectTest(renderer)
    try {
      expect(composerSize()).toBe(15)
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-sans-size').click()
      await app.getByTestId('settings-sans-size-16').click()
      await app.getByTestId('settings-back').click()
      await settle(renderer)
      expect(composerSize()).toBe(16)
    } finally {
      await app.close()
    }
  })

  it('scales inline code with the monospace size', async () => {
    const fake = new FakeEngine()
    fake.replyText = 'use `code` here'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const codeSize = () => textRunStyle(renderer, 'code')?.['fontSize']

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-mono-size').click()
      await app.getByTestId('settings-mono-size-15').click()
      await app.getByTestId('settings-back').click()
      typeSend(renderer, 'hello')
      await settle(renderer)
      expect(codeSize()).toBe(15)
    } finally {
      await app.close()
    }
  })

  it('reveals line height behind Advanced and applies it', async () => {
    const fake = new FakeEngine()
    fake.replyText = 'hello world para'
    const { render, renderer } = createTestRoot({ width: 1280, height: 1400 })
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const bodyLineHeight = () => textRunStyle(renderer, 'hello world para')?.['lineHeight']

    typeSend(renderer, 'hello')
    await settle(renderer)
    expect(bodyLineHeight()).toBe(26)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      expect(renderer.getPaintedText()).not.toContain('Line height')
      await app.getByTestId('settings-advanced').click()
      expect(renderer.getPaintedText()).toContain('Line height')
      await app.getByTestId('settings-line-height').click()
      await app.getByTestId('settings-line-height-compact').click()
      await app.getByTestId('settings-back').click()
      await settle(renderer)
      expect(bodyLineHeight()).toBe(22)
    } finally {
      await app.close()
    }
  })

  it('toggles table word wrap', async () => {
    const fake = new FakeEngine()
    fake.replyText = '| a | b |\n|---|---|\n| alpha beta gamma | x |'
    const { render, renderer } = createTestRoot({ width: 1280, height: 1400 })
    render(<ChatApp client={fake} />)
    await settle(renderer)

    typeSend(renderer, 'hello')
    await settle(renderer)
    const tableOverflow = () =>
      String(renderer.getElement(renderer.findByTestId('mdx-table')!.id)?.style.overflowX ?? '')
    const cellWrap = () =>
      String(renderer.getElement(renderer.findByTestId('mdx-cell')!.id)?.style.whiteSpace ?? '')
    expect(tableOverflow()).toBe('scroll')
    expect(cellWrap()).toBe('nowrap')

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await app.getByTestId('settings-nav-appearance').click()
      await app.getByTestId('settings-word-wrap').click()
      await app.getByTestId('settings-back').click()
      await settle(renderer)
      expect(tableOverflow()).toBe('visible')
      expect(cellWrap()).toBe('normal')
    } finally {
      await app.close()
    }
  })

})

describeNative('safe-mdx', () => {
  it('renders safe-mdx through GPUIX primitives', () => {
    const { render, renderer } = createTestRoot()
    render(<SafeMdxTranscript onCopy={async () => {}} />)

    const screenshot = path.join(SHOTS, 'chat-safe-mdx.png')
    renderer.captureScreenshot(screenshot)

    expect(renderer.findByType('markdown')).toHaveLength(0)
    expect(renderer.findByType('code')).toHaveLength(1)
    expect(fs.statSync(screenshot).size).toBeGreaterThan(0)
    expect(renderer.getPaintedText()).toContain('React-composed Markdown')
  })

  it('renders safe-mdx content', () => {
    const { render, renderer } = createTestRoot()
    render(<SafeMdxContent onCopy={async () => {}} source="Hello **world**" />)
    expect(renderer.getPaintedText().some((line) => line.includes('Hello'))).toBe(true)
    expect(renderer.getPaintedText()).toContain('world')
  })
})

describeNative('composer design mode', () => {
  it('starts a run through its own request rather than a turn', async () => {
    const fake = new FakeEngine()
    fake.designScript = [
      { phase: 'qualify', detail: '' },
      { phase: 'brief', detail: 'accepted' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    // Turn Design on through the toggle, which is the composer's own control.
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('design-toggle').click()
      await settle(renderer)
      typeSend(renderer, 'a landing page for a Go RPC engine')
      await settle(renderer)

      // The request went out as design_start, and no turn was sent for it.
      expect(fake.calls.some((c) => c.method === 'startDesign')).toBe(true)
      expect(fake.calls.some((c) => c.method === 'send')).toBe(false)
      // The phases the run reported are on screen, in order.
      const painted = renderer.getPaintedText().join(' ')
      expect(painted).toContain('Reading the request')
      expect(painted).toContain('Writing the brief')
    } finally {
      await app.close()
    }
  })

  it('shows the verdict and the two viewports when a run passes', async () => {
    const fake = new FakeEngine()
    fake.designResult = { passed: true, repairs: 0, verdict: 'pass', why: '' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('design-toggle').click()
      await settle(renderer)
      typeSend(renderer, 'a landing page')
      await settle(renderer)
      fake.finishDesign()
      await settle(renderer)

      const painted = renderer.getPaintedText().join(' ')
      expect(painted).toContain('Passed review')
      // A passed review is the only thing that yields screenshots.
      expect(painted).toContain('1440x1000')
      expect(painted).toContain('390x844')
    } finally {
      await app.close()
    }
  })

  it('distinguishes a run that could not finish from one that was rejected', async () => {
    // Both look like failure if flattened into one "not accepted" string, and
    // the two mean opposite things: one is a machine problem, the other a
    // design the reviewer would not sign off.
    const fake = new FakeEngine()
    fake.failDesignWith = 'capture needs agent-browser on PATH'
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('design-toggle').click()
      await settle(renderer)
      typeSend(renderer, 'a landing page')
      await settle(renderer)
      fake.finishDesign()
      await settle(renderer)

      const painted = renderer.getPaintedText().join(' ')
      expect(painted).toContain('capture needs agent-browser on PATH')
      expect(painted).not.toContain('Not accepted after')
    } finally {
      await app.close()
    }
  })
})

describeNative('add project dialog', () => {
  const open = async (fake: FakeEngine) => {
    const { render, renderer } = createTestRoot({ onKeyDown: dispatchWindowKey })
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    await app.getByTestId('add-project').click()
    await settle(renderer)
    return { renderer, app }
  }

  it('opens on a field showing where a relative path starts', async () => {
    // The whole point of the field: "Projects/escape" is a path from the start
    // directory, so the dialog says what it is relative to rather than leaving
    // the reader to work it out.
    const fake = new FakeEngine()
    const { renderer, app } = await open(fake)
    try {
      const field = renderer.findByTestId('project-path-input')!
      expect(String(field?.customProps?.value)).toBe('~/')
      expect(renderer.findByTestId('project-path-hint')).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('sends what was typed, rather than a path it picked', async () => {
    // Resolution is the engine's: expanding a tilde and resolving a relative
    // path are filesystem facts, and doing them here too would be two
    // implementations that drift.
    const fake = new FakeEngine()
    const { renderer, app } = await open(fake)
    try {
      const field = renderer.findByTestId('project-path-input')!
      renderer.nativeSimulateKeystrokes(field.id, 'Projects/escape'.split('').join(' '))
      await settle(renderer)
      renderer.nativeSimulateKeyDown(field.id, 'enter')
      await settle(renderer)
      expect(fake.calls.find((c) => c.method === 'addProject')?.args?.[0]).toBe(
        '~/Projects/escape',
      )
    } finally {
      await app.close()
    }
  })

  it('switches to the path the engine resolved, not the text that was typed', async () => {
    // The engine answers with an absolute path. Switching to the raw text would
    // move to a directory that does not exist, and would look like it worked.
    const fake = new FakeEngine()
    fake.addProjectResult = {
      project: { path: '/Users/tester/Projects/escape' },
      added: true,
    }
    const { renderer, app } = await open(fake)
    try {
      const field = renderer.findByTestId('project-path-input')!
      renderer.nativeSimulateKeystrokes(field.id, 'Projects/escape'.split('').join(' '))
      await settle(renderer)
      renderer.nativeSimulateKeyDown(field.id, 'enter')
      await settle(renderer)
      expect(
        fake.calls.find((c) => c.method === 'switchProject')?.args?.[0],
      ).toBe('/Users/tester/Projects/escape')
    } finally {
      await app.close()
    }
  })

  it('says a project was already there instead of claiming to add it', async () => {
    // The engine reports added=false for a duplicate. Reporting "Added" would
    // be a lie the user cannot check.
    const fake = new FakeEngine()
    fake.addProjectResult = { project: { path: '/Users/tester/Projects/escape' }, added: false }
    const { renderer, app } = await open(fake)
    try {
      const field = renderer.findByTestId('project-path-input')!
      renderer.nativeSimulateKeystrokes(field.id, 'Projects/escape'.split('').join(' '))
      await settle(renderer)
      renderer.nativeSimulateKeyDown(field.id, 'enter')
      await settle(renderer)
      const painted = renderer.getPaintedText().join(' ')
      expect(painted).toContain('is already a project')
      expect(painted).not.toContain('Added escape')
    } finally {
      await app.close()
    }
  })

  it('shows the engine message when the path is not a directory', async () => {
    const fake = new FakeEngine()
    fake.failures = { addProject: 'no such directory' }
    const { renderer, app } = await open(fake)
    try {
      const field = renderer.findByTestId('project-path-input')!
      renderer.nativeSimulateKeystrokes(field.id, 'nope'.split('').join(' '))
      await settle(renderer)
      renderer.nativeSimulateKeyDown(field.id, 'enter')
      await settle(renderer)
      expect(renderer.getPaintedText().join(' ')).toContain('no such directory')
    } finally {
      await app.close()
    }
  })
})




describe('palette contrast floors', () => {
  // The reason `muted` exists. tertiary and ghost are too dark to read as text on
  // a raised surface, but they are correct for chevrons, dots and rules, which
  // only need 3:1. So the fix is a separate token rather than re-tuning two
  // existing ones, and this pins that every surface clears the 4.5 floor.
  const srgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = (hex: string) => {
    const h = hex.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b)
  }
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }
  const SURFACES = ['canvas', 'sidebar', 'raised', 'composer'] as const

  it('gives every theme a muted that clears 4.5:1 on every surface', () => {
    for (const { palette } of Object.values(THEMES)) {
      for (const surface of SURFACES) {
        const ratio = contrast(palette.muted, palette[surface])
        expect(
          ratio,
          `${palette.muted} on ${palette[surface]} is ${ratio.toFixed(2)}:1, below 4.5`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keeps muted distinct from ghost, which stays for non-text marks', () => {
    // If these converge, the two roles have blurred and the next person to edit
    // a chevron will silently break every de-emphasized label.
    for (const { palette } of Object.values(THEMES)) {
      expect(palette.muted).not.toBe(palette.ghost)
      expect(contrast(palette.muted, palette.canvas)).toBeGreaterThan(
        contrast(palette.ghost, palette.canvas),
      )
    }
  })
})

describeNative('design run screenshots', () => {
  it('shows the capture the engine wrote, not a placeholder', async () => {
    // These were grey boxes. A run claims a visual review happened, so showing
    // an empty rectangle tells the reader something the engine did not do.
    const fake = new FakeEngine()
    fake.designResult = { passed: true, repairs: 0, verdict: 'pass', why: '' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const app = await connectTest(renderer)
    try {
      await app.getByTestId('design-toggle').click()
      await settle(renderer)
      typeSend(renderer, 'a landing page')
      await settle(renderer)
      fake.finishDesign()
      await settle(renderer)

      // One per viewport, each pointing at the file the engine wrote. The
      // fake hands out the paths its design_done event carries.
      for (const [viewport, path] of [
        ['shot-1440x1000', '/tmp/desktop.png'],
        ['shot-390x844', '/tmp/mobile.png'],
      ]) {
        const el = renderer.findByTestId(`design-shot-${viewport}`)!
        expect(el.type).toBe('img')
        expect(el.customProps?.src).toBe(path)
        // Named for a screen reader, not an image with no description.
        expect(String(el.customProps?.alt ?? '').length).toBeGreaterThan(0)
      }
    } finally {
      await app.close()
    }
  })
})


describe('motion vocabulary', () => {
  it('pins the durations to the values the timings were chosen against', () => {
    // Every animation in the shell reads these. Changing one silently changes
    // the feel of the app, so the numbers are a decision rather than a default.
    expect(DURATION.micro).toBeLessThanOrEqual(150)
    expect(DURATION.enter).toBeLessThanOrEqual(200)
    expect(DURATION.overlay).toBeLessThanOrEqual(250)
    // Leaving is quicker than arriving: a dismissal the reader has already asked
    // for should not hold them for the full enter.
    expect(DURATION.exit).toBeLessThan(DURATION.enter)
    // The 300ms ceiling. Past it an interface feels like it is lagging behind
    // the click rather than responding to it.
    expect(DURATION.overlay).toBeLessThan(300)
  })

  it('converts milliseconds to the seconds GPUIX wants', () => {
    expect(fadeIn(200).transition?.duration).toBeCloseTo(0.2)
  })

  it('drops the travel but keeps the fade when reduced motion is asked for', () => {
    // Not "remove all animation": an instant appearance still says something
    // arrived, where no change at all can read as a missed repaint.
    __setReducedMotionForTest(true)
    const reduced = fadeIn(200)
    __setReducedMotionForTest(false)
    const normal = fadeIn(200)
    expect(reduced.transition?.duration).toBe(0)
    expect(normal.transition?.duration).toBeCloseTo(0.2)
    // The fade survives either way.
    expect(reduced.animate).toEqual(normal.animate)
  })

  it('actually reaches the renderer rather than being dropped', () => {
    // A motion prop that the host silently ignores looks identical in code
    // review to one that works. The renderer records it, so assert on that.
    // motion.div does not forward testId, so the probe is found by type. It is
    // the only div in this root, which is what makes that unambiguous.
    const { render: r, renderer } = createTestRoot()
    r(<motion.div {...fadeIn(DURATION.overlay)} style={{ width: 4, height: 4 }} /> as never)
    renderer.flush()
    // findByType returns every match; the probe is the only div in this root.
    const recorded = (renderer.findByType('div') as unknown as Array<{ customProps?: Record<string, unknown> }>)[0]!
      .customProps?.motion as
      | { initial?: { opacity?: number }; animate?: { opacity?: number } }
      | undefined
    expect(recorded?.initial?.opacity).toBe(0)
    expect(recorded?.animate?.opacity).toBe(1)
  })
})

describe('no left-edge markers', () => {
  // A 2-3px accent bar on the leading edge of a selected row is banned. It is
  // the most recognisable piece of generic generated UI, and it marks position
  // when position is already carried by indent, surface and weight.
  //
  // These scan the source because the failure mode is a pattern rather than a
  // runtime behaviour: nothing looks wrong in a screenshot until you notice the
  // bar, and no behavioural test fails unless a test is looking for the bar.
  const sources = ['app.tsx', 'design-run.tsx', 'theme-tokens.ts'].map((name) => ({
    name,
    text: fs.readFileSync(path.join(__dirname, name), 'utf8'),
  }))

  it('has no one-sided border on a list row or selected item', () => {
    // A panel edge is not a selection marker, so a one-sided border is only
    // wrong when it is not one. The window of surrounding lines is what
    // distinguishes them: a lone `borderRightWidth` line says nothing, the
    // element it belongs to says whether it is a sidebar, a rail or a row.
    for (const { name, text } of sources) {
      const lines = text.split('\n')
      const offenders: string[] = []
      lines.forEach((line, i) => {
        if (!/borderLeftWidth|borderRightWidth/.test(line)) return
        const context = lines.slice(Math.max(0, i - 8), i + 3).join(' ')
        if (/sidebar|rail|panel|gutter/i.test(context)) return
        offenders.push(`${name}:${i + 1} ${line.trim()}`)
      })
      expect(offenders, `one-sided border off a panel: ${offenders.join(' | ')}`).toHaveLength(0)
    }
  })

  it('draws no narrow accent bar as a row marker', () => {
    // The selection marker specifically: a 2-3px accent element next to a row
    // that carries an `active` flag. The markdown blockquote is a different
    // thing and is checked separately below, because it is a real open question
    // rather than a recurrence of this pattern.
    for (const { name, text } of sources) {
      const offenders = (text.match(/width:\s*2,[\s\S]{0,120}?C\.accent/g) ?? []).filter(
        (hit) => /active|selected|isActive/.test(hit),
      )
      expect(offenders, `${name} marks a row with an accent bar: ${offenders.join(' | ')}`).toHaveLength(0)
    }
  })

  it('marks the current project with a check, not a bar', () => {
    // The rule is not "no way to tell which row is current" — it is "not with a
    // bar". A check beside the name is the replacement, and this holds the line
    // for the row that took the palette's place.
    //
    // Scoped to the row's own source rather than the file, because a panel edge
    // is not a selection marker and the check above already distinguishes them.
    const { text } = sources[0]!
    const start = text.indexOf('function ProjectRow(')
    expect(start).toBeGreaterThan(-1)
    const row = text.slice(start, text.indexOf('\n}\n', start))
    expect(row).toContain('{current && <Icon name="check"')
    expect(row).not.toMatch(/borderLeftWidth|borderRightWidth/)
  })
})

describe('key names', () => {
  // The arrow keys were dead in the app while every test passed, because the
  // test renderer spells them the DOM way and GPUI does not. These tests pin
  // the platform's spelling, so a handler written against the harness's names
  // cannot pass again.
  it("accepts GPUI's spelling of the arrow keys", () => {
    // Taken from @gpuix/react's own ComboboxInput, which compares against
    // "up" and "down" and never against "ArrowUp".
    expect(normaliseKey('down')).toBe('down')
    expect(normaliseKey('up')).toBe('up')
  })

  it('also accepts the DOM spelling the test renderer produces', () => {
    // Both are real. The harness emits "arrowdown"; the window emits "down".
    // Code under test has to behave the same under both or it is measuring
    // something the app never does.
    expect(normaliseKey('arrowdown')).toBe('down')
    expect(normaliseKey('arrowup')).toBe('up')
  })

  it('names the space bar the way GPUI does', () => {
    // The DOM delivers " "; GPUI's own components compare against "space".
    expect(normaliseKey('space')).toBe('space')
    expect(normaliseKey(' ')).toBe('space')
  })

  it('handles enter, escape and the positional keys', () => {
    expect(normaliseKey('enter')).toBe('enter')
    expect(normaliseKey('return')).toBe('enter')
    expect(normaliseKey('escape')).toBe('escape')
    expect(normaliseKey('home')).toBe('home')
    expect(normaliseKey('end')).toBe('end')
  })

  it('is total, and says so for anything it does not know', () => {
    expect(normaliseKey(undefined)).toBe('other')
    expect(normaliseKey('')).toBe('other')
    expect(normaliseKey('f13')).toBe('other')
  })
})


describeNative('sidebar projects and recent sessions', () => {
  it('lists the projects in the sidebar, not behind a dropdown', async () => {
    // They used to be reachable only through a chip menu, which is why adding a
    // project appeared to do nothing.
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/projects/alpha' },
      { path: '/Users/tester/projects/beta' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    expect(renderer.findByTestId('sidebar-project-/Users/tester/projects/alpha')).toBeDefined()
    expect(renderer.findByTestId('sidebar-project-/Users/tester/projects/beta')).toBeDefined()
    const painted = renderer.getPaintedText().join(' ')
    expect(painted).toContain('alpha')
    expect(painted).toContain('beta')
  })

  it('marks the current project, without a left-edge bar', async () => {
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/projects/alpha' },
      { path: '/Users/tester/projects/beta' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const current = renderer.findByTestId('sidebar-project-/Users/tester/projects/alpha')
    const other = renderer.findByTestId('sidebar-project-/Users/tester/projects/beta')
    // The state has to reach assistive technology, not just the paint. A check
    // icon and a background tint are invisible to a screen reader.
    expect(current?.customProps?.['aria-selected']).toBe(true)
    expect(other?.customProps?.['aria-selected']).toBe(false)
    // And the name says which one is current, so it is not colour-dependent.
    expect(String(current?.customProps?.['aria-label'])).toContain('current project')
  })

  it('switches project when a row is clicked', async () => {
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/projects/alpha' },
      { path: '/Users/tester/projects/beta' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('sidebar-project-/Users/tester/projects/beta').click()
      await settle(renderer)
      expect(
        fake.calls.some(
          (c) => c.method === 'switchProject' && c.args[0] === '/Users/tester/projects/beta',
        ),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('shows the project recent sessions in the chat area, and nothing else', async () => {
    // The list replaces the transcript only while nothing is open.
    const now = Date.now()
    const fake = new FakeEngine()
    fake.sessions = [
      { id: 's1', path: 'sess-1', cwd: '/Users/tester/projects/alpha', name: 'First', updatedAt: now },
    ]
    fake.transcripts = { 'sess-1': [{ id: 'm1', role: 'user', content: 'first question' }] }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)

    const painted = renderer.getPaintedText().join(' ')
    expect(painted).toContain('Recent in alpha')
    expect(painted).toContain('First')
    // The transcript of nothing is not on screen behind it.
    expect(painted).not.toContain('first question')
  })

  it('returns to the session list when the current project is clicked again', async () => {
    const now = Date.now()
    const fake = new FakeEngine()
    fake.sessions = [
      { id: 's1', path: 'sess-1', cwd: '/Users/tester/projects/alpha', name: 'First', updatedAt: now },
    ]
    fake.transcripts = { 'sess-1': [{ id: 'm1', role: 'user', content: 'first question' }] }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('thread-sess-1').click()
      await settle(renderer)
      expect(renderer.getPaintedText().join(' ')).toContain('first question')

      await app.getByTestId('sidebar-project-/Users/tester/projects/alpha').click()
      await settle(renderer)
      expect(renderer.findByTestId('recent-sessions')).toBeDefined()
    } finally {
      await app.close()
    }
  })

  it('gives the transcript back the moment a turn starts', async () => {
    // Sending from the list replaces it immediately, even with the turn held
    // open: the session id arrives before the send is awaited, so the list never
    // lingers over a turn. This is the same class of bug that hid the Design
    // Mode verdict behind the list for a whole run.
    const fake = new FakeEngine()
    fake.pauseSend = true
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    expect(renderer.findByTestId('recent-sessions')).toBeDefined()

    typeSend(renderer, 'hello')
    await settle(renderer)
    expect(renderer.findByTestId('recent-sessions')).toBeUndefined()

    fake.releaseSend()
    await settle(renderer)
  })

  it('starts a new chat from the session list when a message is sent', async () => {
    // The composer stays live under the list, and send() opens a session when
    // none is active, so typing here needs no separate "new" gesture.
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      expect(renderer.findByTestId('recent-sessions')).toBeDefined()
      typeSend(renderer, 'hello from the list')
      for (let i = 0; i < 40 && !fake.calls.some((c) => c.method === 'send'); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      await settle(renderer)
      expect(fake.calls.some((c) => c.method === 'newSession')).toBe(true)
      expect(fake.calls.some((c) => c.method === 'send')).toBe(true)
    } finally {
      await app.close()
    }
  })
})

describe('engine working directory', () => {
  // The client used to substitute the home directory when it saw "/", which is
  // what macOS hands a Finder-opened app. That quietly won over the engine's
  // defaultProject setting, because the engine never saw the root to reject.
  // The engine owns the decision now; the client only passes a real directory
  // through.
  const originalEnv = process.env.ESCAPE_CWD

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ESCAPE_CWD
    else process.env.ESCAPE_CWD = originalEnv
  })

  it('passes a real working directory through untouched', () => {
    expect(resolveEngineCwd('/Users/tester/Projects/alpha')).toBe('/Users/tester/Projects/alpha')
  })

  it('passes the root through for the engine to reject', () => {
    // Not "/" becoming something else. The engine is the only thing that knows
    // what the configured default is, and pre-empting it here is what made the
    // setting do nothing.
    expect(resolveEngineCwd('/')).toBe('/')
  })

  it('does not invent a directory when the caller has none', () => {
    delete process.env.ESCAPE_CWD
    expect(resolveEngineCwd(undefined)).toBe(process.cwd())
    expect(resolveEngineCwd('   ')).toBe(process.cwd())
  })

  it('lets ESCAPE_CWD override everything except an explicit argument', () => {
    process.env.ESCAPE_CWD = '/Users/tester/Projects/beta'
    expect(resolveEngineCwd(undefined)).toBe('/Users/tester/Projects/beta')
    expect(resolveEngineCwd('/Users/tester/Projects/gamma')).toBe(
      '/Users/tester/Projects/gamma',
    )
  })
})

describe('starting directory setting', () => {
  it('shows the engine\'s value, and reads ~/ when nothing is set', async () => {
    const fake = new FakeEngine()
    fake.state = { ...fake.state, defaultProject: '/Users/tester/Projects/alpha' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await settle(renderer)
      const field = renderer.findByTestId('settings-start-dir')
      expect(field).toBeDefined()
      expect(String(field?.customProps?.value)).toBe('/Users/tester/Projects/alpha')
      // The default is the home folder, and the field says so rather than
      // sitting blank with the answer hidden.
      expect(String(field?.customProps?.placeholder)).toBe('~/')
    } finally {
      await app.close()
    }
  })

  it('writes through the engine when the value is set', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await settle(renderer)
      const field = renderer.findByTestId('settings-start-dir')!
      renderer.nativeSimulateKeystrokes(field.id, '/Users/tester/Projects/beta'.split('').join(' '))
      await settle(renderer)
      await app.getByTestId('settings-start-dir-apply').click()
      await settle(renderer)
      expect(
        fake.calls.find((c) => c.method === 'setDefaultProject')?.args?.[0],
      ).toBe('/Users/tester/Projects/beta')
    } finally {
      await app.close()
    }
  })

  it('passes a tilde through for the engine to expand', async () => {
    // "~/Projects/thing" is what a person writes. Expanding it here would need a
    // second implementation of the same rule, and the engine already owns it.
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await settle(renderer)
      const field = renderer.findByTestId('settings-start-dir')!
      renderer.nativeSimulateKeystrokes(field.id, '~/Projects/beta'.split('').join(' '))
      await settle(renderer)
      await app.getByTestId('settings-start-dir-apply').click()
      await settle(renderer)
      expect(fake.calls.find((c) => c.method === 'setDefaultProject')?.args?.[0]).toBe(
        '~/Projects/beta',
      )
    } finally {
      await app.close()
    }
  })

  it('clears the value, which hands the decision back to the home directory', async () => {
    const fake = new FakeEngine()
    fake.state = { ...fake.state, defaultProject: '/Users/tester/Projects/alpha' }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      await app.getByTestId('settings').click()
      await settle(renderer)
      await app.getByTestId('settings-start-dir-clear').click()
      await settle(renderer)
      expect(fake.calls.find((c) => c.method === 'setDefaultProject')?.args?.[0]).toBe('')
    } finally {
      await app.close()
    }
  })
})

describe('project list order', () => {
  // The list was in the order projects were added, which buries the one you
  // actually work in as the list grows. The engine sorts on last use; this
  // holds the shell to reading that order rather than re-sorting or reversing.
  it('lists projects in the order the engine gives them', async () => {
    const fake = new FakeEngine()
    // Deliberately not alphabetical and not insertion order.
    fake.projects = [
      { path: '/Users/tester/Projects/zeta' },
      { path: '/Users/tester/Projects/alpha' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      const painted = renderer.getPaintedText().join(' ')
      // zeta comes first because the engine said so, so the shell must not
      // alphabetise it away.
      expect(painted.indexOf('zeta')).toBeLessThan(painted.indexOf('alpha'))
    } finally {
      await app.close()
    }
  })

  it('refetches the list after a switch, so the order can change', async () => {
    // The order is the engine's to decide, and it only changes when the engine
    // records the use. If the shell kept its first list, the sidebar would not
    // move even though the engine had reordered.
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/Projects/alpha' },
      { path: '/Users/tester/Projects/beta' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      const before = fake.calls.filter((c) => c.method === 'listProjects').length
      await app.getByTestId('sidebar-project-/Users/tester/Projects/beta').click()
      await settle(renderer)
      expect(
        fake.calls.filter((c) => c.method === 'listProjects').length,
      ).toBeGreaterThan(before)
    } finally {
      await app.close()
    }
  })
})

describe('sidebar footer placement', () => {
  // The settings row sat directly under the last project and rode up with the
  // content as the window got taller, because nothing in the sidebar column
  // claimed the remaining height. Asserted on real geometry rather than on the
  // source, because the harness has no layout engine but it does report
  // element bounds, and "where is it on screen" is the actual claim.
  const bounds = (renderer: TestRenderer, id: string) => {
    const el = renderer.findByTestId(id)
    expect(el, `${id} should exist`).toBeDefined()
    const get = (renderer as unknown as {
      getElementBounds: (id: number) => { x: number; y: number; width: number; height: number }
      getWindowSize: () => { width: number; height: number }
    })
    return {
      footer: get.getElementBounds(el!.id),
      window: get.getWindowSize(),
    }
  }

  it('sits at the bottom of the sidebar, not under the last project', async () => {
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/Projects/a' },
      { path: '/Users/tester/Projects/b' },
    ]
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      const { footer, window: size } = bounds(renderer, 'sidebar-footer')
      expect(footer.y + footer.height).toBe(size.height)
      // And it is not riding up under the content: the project list ends well
      // above it, so there is empty column in between.
      const list = bounds(renderer, 'sidebar-projects')
      expect(list.footer.y + list.footer.height).toBeLessThan(footer.y)
    } finally {
      await app.close()
    }
  })

  it('stays at the bottom when the list is long enough to scroll', async () => {
    // The list caps at 45% and scrolls, so this is the case where the footer and
    // the list could collide if the spacer were not taking the remainder.
    const fake = new FakeEngine()
    fake.projects = Array.from({ length: 30 }, (_, i) => ({ path: `/Users/tester/Projects/p${i}` }))
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      const { footer, window: size } = bounds(renderer, 'sidebar-footer')
      const list = bounds(renderer, 'sidebar-projects')
      expect(footer.y + footer.height).toBe(size.height)
      expect(list.footer.y + list.footer.height).toBeLessThanOrEqual(footer.y)
    } finally {
      await app.close()
    }
  })
})

describe('keyboard activation', () => {
  // Every activatable control answers to Enter and Space, which is the platform
  // convention. Twenty of them compared against the DOM's " " and the platform
  // sends "space", so Space activated nothing anywhere in the app while every
  // test passed, because the assertions never pressed it.
  it('activates a control with Space, using the platform\'s spelling', async () => {
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/Projects/alpha' },
      { path: '/Users/tester/Projects/beta' },
    ]
    const { render, renderer } = createTestRoot({ onKeyDown: dispatchWindowKey })
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      const row = renderer.findByTestId('sidebar-project-/Users/tester/Projects/beta')!
      renderer.nativeSimulateKeyDown(row.id, 'space')
      await settle(renderer)
      expect(
        fake.calls.find((c) => c.method === 'switchProject')?.args?.[0],
      ).toBe('/Users/tester/Projects/beta')
    } finally {
      await app.close()
    }
  })

  it('still activates with Enter, so the fix did not trade one key for another', async () => {
    const fake = new FakeEngine()
    fake.projects = [
      { path: '/Users/tester/Projects/alpha' },
      { path: '/Users/tester/Projects/beta' },
    ]
    const { render, renderer } = createTestRoot({ onKeyDown: dispatchWindowKey })
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      const row = renderer.findByTestId('sidebar-project-/Users/tester/Projects/beta')!
      renderer.nativeSimulateKeyDown(row.id, 'enter')
      await settle(renderer)
      expect(
        fake.calls.find((c) => c.method === 'switchProject')?.args?.[0],
      ).toBe('/Users/tester/Projects/beta')
    } finally {
      await app.close()
    }
  })
})

describe('focus indication', () => {
  // WCAG 2.4.7 asks for a visible focus indicator and the app had none: there
  // was no focus handling anywhere, so a person tabbing through the controls
  // could not tell which one they were on. The style description offers hover
  // and active variants and nothing for focus, so it is drawn from the focus
  // events as an inset shadow, which costs no layout.
  it('draws a ring when a control takes focus', async () => {
    const fake = new FakeEngine()
    const { render, renderer } = createTestRoot({ onKeyDown: dispatchWindowKey })
    render(<ChatApp client={fake} />)
    await settle(renderer)
    const app = await connectTest(renderer)
    try {
      // What the harness cannot do is asserted here rather than skipped: it
      // consumes `style` itself, so the resolved value is never exposed through
      // customProps, and there is no way to observe a resolved shadow. So the
      // claim is made against the shim's source, which is the one place every
      // control in the app gets the ring from, and the ring's geometry is
      // asserted directly below. Claiming more than this from a test would be
      // claiming something it cannot see.
      const source = fs.readFileSync(path.join(__dirname, 'app.tsx'), 'utf8')
      const shim = source.slice(source.indexOf('function Button({'), source.indexOf('const DialogContext'))
      expect(shim).toContain('onFocus={ring.focusProps.onFocus}')
      expect(shim).toContain('...ring.style')
    } finally {
      await app.close()
    }
  })

  it('is drawn inset, so it cannot move the layout', () => {
    // A border would shift every control by its own width, and a fill would be
    // indistinguishable from hover, which is already a fill in this app. The
    // negative spread is what keeps it inside the control's own bounds.
    const ring = focusRingForTest()
    expect(ring.spreadRadius).toBeLessThan(0)
    expect(ring.offsetX).toBe(0)
    expect(ring.offsetY).toBe(0)
    expect(ring.color).toBe(C.accent)
  })
})
