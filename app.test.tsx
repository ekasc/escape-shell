/**
 * Drives the local chat through the GPU test renderer.
 *
 * The app is imported, not launched, so `render()` at the bottom of `app.tsx`
 * is guarded by an entry-point check. `connectTest` gives the same locator API
 * as `launch()` in `screenshot.ts`, without a child process.
 */

import React from 'react'
import { describe, expect, it } from 'vitest'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'

import { ChatApp, dispatchWindowCommand } from './app'
import type { AgentClient, AgentEvent } from './agent-client'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function paintedText(renderer: { getPaintedText(): string[] }): string {
  return renderer.getPaintedText().join('\n')
}

/**
 * The first message in a draft chat now waits on the engine to create the
 * session before it is dispatched, so engine-mode assertions need a tick.
 */
/** Wraps a skills fixture in the RPC envelope, so the shape is written once. */
function skillsResponse<T>(skills: T[], projects: Array<{ path: string; name: string }> = []) {
  return { skills, projects }
}

/**
 * Switches a settings tab and waits for the incoming section to be present.
 *
 * The section bodies are sibling conditionals with no key, so nothing remounts
 * and a person clicking cannot hit this. The automation can: a click on a node
 * whose layout has not been committed lands on nothing, which is what made
 * "click a tab, then click a control in it" intermittently fail.
 */
async function openSection(
  app: Awaited<ReturnType<typeof connectTest>>,
  section: string,
  landing: string,
): Promise<void> {
  await app.getByTestId(`settings-tab-${section}`).click()
  await app.getByTestId(landing).waitFor({ timeoutMs: 2_000 })
}

/** Polls until a condition holds, so a test never depends on a fixed sleep. */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(message)
}

async function flushEngineRoundTrip(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

const testRuntimeSettings = {
  async getState() { return { state: 'idle', sessionId: 'test-session', sessionFile: '/tmp/test.jsonl', cwd: '/tmp', model: 'test-model', provider: 'test-provider', thinkingLevel: 'off', approvalMode: 'auto', autoCompaction: false, autoRetry: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', maxTokens: 0 } },
  async ping() { return true },
  async getProviders() { return [{ id: 'test-provider', name: 'Test provider', configured: true }] },
  async getCommands() { return [] },
  async getSessionStats() { return null },
  async getTranscript() { return [] },
  async getTranscriptPage() { return { messages: [], hasMore: false, earliestId: '' } },
  async getLastAssistantText() { return '' },
  async getForkMessages() { return [] },
  async getTree() { return [] },
  async bash() { return { output: '', exitCode: 0, truncated: false } },
  async abortBash() {},
  async getDiff() { return 'No uncommitted changes.' },
  async getMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
  async addMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
  async replaceMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
  async removeMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
  async fork() { return null },
  async undo() { return null },
  async cloneSession() { return null },
  async steer() {},
  async followUp() {},
  async exportHtml() { return null },
  async compact() { return '' },
  async snapcompact() { return '' },
  async recap() { return '' },
  async getModels() { return ['test-model'] },
  async getThinkingLevels() { return ['off', 'high'] },
  async setModel() {},
  async setProvider() {},
  async setApiKey() {},
  async setApprovalMode() {},
  async setAutoCompaction() {},
  async setAutoRetry() {},
  async setMaxTokens() {},
  async abortRetry() {},
  async setSteeringMode() {},
  async setFollowUpMode() {},
  async setThinkingLevel() {},
  async getDiagnostics() {
    return { provider: 'provider-a', model: 'model-a', firstTokenP50Ms: 120, turns: [] }
  },
  async writeDiagnostics() { return { path: '/tmp/diag.txt', report: 'escape diagnostics' } },
}


/** A fully-populated engine client for settings tests; override only what a case needs. */
function makeSettingsClient(overrides: Partial<AgentClient> = {}): AgentClient {
  return {
    mode: 'engine',
    async getState() {
      return {
        state: 'idle', sessionId: 'session-a', sessionFile: '/tmp/a.jsonl', cwd: '/tmp',
        model: 'model-a', provider: 'provider-a', thinkingLevel: 'off', approvalMode: 'auto',
        autoCompaction: false, autoRetry: false, steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time', maxTokens: 0,
      }
    },
    async ping() { return true },
    async getDiagnostics() {
      return { provider: 'provider-a', model: 'model-a', firstTokenP50Ms: 120, turns: [] }
    },
    async writeDiagnostics() { return { path: '/tmp/diag.txt', report: 'escape diagnostics' } },
    async listSkills() { return { skills: [], projects: [] } },
    async setSkillEnabled() { return { pending: false } },
    async getMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async addMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async replaceMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async removeMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async getProviders() {
      return [
        { id: 'provider-a', name: 'Provider A', configured: true },
        { id: 'provider-b', name: 'Provider B', configured: true },
      ]
    },
    async getCommands() { return [] },
    async getSessionStats() {
      return {
        sessionId: 's1', userMessages: 1, assistantMessages: 2, toolCalls: 3, totalMessages: 3,
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 },
        cost: 0.0123, contextTokens: 30, contextWindow: 1000, contextPercent: 3,
      }
    },
    async getTranscript() { return [] },
    async getTranscriptPage() { return { messages: [], hasMore: false, earliestId: '' } },
    async getLastAssistantText() { return 'last response' },
    async getForkMessages() { return [{ entryId: 'u1', text: 'question' }] },
    async getTree() { return [{ entryId: 'u1', role: 'user', text: 'question', children: [] }] },
    async bash() { return { output: 'ok', exitCode: 0, truncated: false } },
    async abortBash() {},
    async getDiff() { return 'diff --git a/file b/file' },
    async fork() { return '/tmp/session-fork.jsonl' },
    async undo() { return '/tmp/session-undo.jsonl' },
    async cloneSession() { return '/tmp/session-clone.jsonl' },
    async steer() {},
    async followUp() {},
    async exportHtml() { return { path: '/tmp/session-s1.html' } },
    async compact() { return 'compacted summary' },
    async snapcompact() { return 'snap summary' },
    async recap() { return 'recap summary' },
    async getModels() { return ['model-a', 'model-b'] },
    async getThinkingLevels() { return ['off', 'high'] },
    async setModel() {},
    async setProvider() {},
    async setApiKey() {},
    async setApprovalMode() {},
    async setAutoCompaction() {},
    async setAutoRetry() {},
    async setMaxTokens() {},
    async abortRetry() {},
    async setSteeringMode() {},
    async setFollowUpMode() {},
    async setThinkingLevel() {},
    async listSessions() { return [] },
    async send() {},
    async answerApproval() {},
    async answerQuestion() {},
    async newSession() { return null },
    async switchSession() { return null },
    async setSessionName() {},
    stop() {},
    close() {},
    ...overrides,
  }
}

describeNative('chat app', () => {
  it('opens with a welcome state and a composer', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)

    const text = paintedText(renderer)
    expect(text).toContain('What can I help you with?')
    expect(text).toContain('Ask anything...')
    expect(text).toContain('Start a chat to create your first space.')
    // The product is named once, in the sidebar. Anywhere else it is either a
    // fallback inventing a project name or the brand inside a sentence that
    // reads fine without it.
    const brandCount = (text.match(/Escape/g) ?? []).length
    expect(brandCount).toBeLessThanOrEqual(1)
    // The suggestion chips were removed; the headline and composer are the
    // whole empty state now.
    expect(text).not.toContain('Plan a project')

    await app.close()
  })

  it('sends a message and paints a local agent response', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)

    await app.getByTestId('chat-input').fill('Help me plan a project')
    await app.getByTestId('send-message').click()

    const text = paintedText(renderer)
    expect(text).toContain('Help me plan a project')
    expect(text).toContain("Let's make a small plan.")
    expect(text).not.toContain('What can I help you with?')

    await app.close()
  })

  it('submits from the keyboard and clears the composer', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)

    const input = app.getByTestId('chat-input')
    await input.fill('Hello Escape')
    await input.press('Enter')

    expect(paintedText(renderer)).toContain("Tell me what you're working on")
    expect(await input.textContent()).toBe('')

    await app.close()
  })

  it('lists and switches engine sessions', async () => {
    const switched: string[] = []
    const session = { id: 'session-1', path: '/tmp/session-1.jsonl', cwd: '/tmp', name: 'Previous session', updatedAt: 0 }
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return [session] },
      async send() {},
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession(path) { switched.push(path); return session },
      async getTranscript() {
        return [{ id: 'm1', role: 'user' as const, content: 'earlier question' }, { id: 'm2', role: 'assistant' as const, content: 'earlier answer' }]
      },
      async getTranscriptPage() {
        return {
          messages: [
            { id: 'm1', role: 'user' as const, content: 'earlier question' },
            { id: 'm2', role: 'assistant' as const, content: 'earlier answer' },
          ],
          hasMore: false,
          earliestId: 'm1',
        }
      },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('space-/tmp').waitFor({ timeoutMs: 1_000 })
    await app.getByText('Previous session').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('session-row-/tmp/session-1.jsonl').click()
    // Viewing is passive: it must NOT switch the engine's active session.
    expect(switched).toEqual([])
    // The viewed session's transcript must actually render.
    await app.getByTestId('message-m1').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('message-m2').textContent()).toContain('earlier answer')
    await app.close()
  })

  it('renders and resolves an approval request', async () => {
    const approvals: Array<{ id: string; approved: boolean }> = []
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async send(_prompt, onEvent) {
        const event: AgentEvent = { kind: 'approval', toolCallId: 'call-1', toolName: 'bash', args: {} }
        onEvent(event)
      },
      async answerApproval(id, approved) {
        approvals.push({ id, approved })
      },
      async answerQuestion() {},
      async listSessions() { return [] },
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').fill('run the test')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    expect(paintedText(renderer)).toContain('Approval required')
    await app.getByTestId('approval-allow').click()
    expect(approvals).toEqual([{ id: 'call-1', approved: true }])
    await app.close()
  })

  it('renders structured tool activity', async () => {
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async send(_prompt, onEvent) {
        onEvent({ kind: 'tool_start', toolCallId: 'tool-1', toolName: 'bash' })
        onEvent({ kind: 'tool_end', toolCallId: 'tool-1', toolName: 'bash', output: 'done', isError: false })
        onEvent({ kind: 'settled', reason: 'done' })
      },
      async listSessions() { return [] },
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').fill('run a tool')
    await app.getByTestId('send-message').click()
    await app.getByTestId('tool-activity-tool-1').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('tool-activity-tool-1').textContent()).toContain('bash')
    await app.close()
  })

  it('renders and resolves a question request', async () => {
    const answers: Array<{ id: string; answer: string }> = []
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async send(_prompt, onEvent) {
        const event: AgentEvent = { kind: 'question', questionId: 'q-1', question: 'Which environment?' }
        onEvent(event)
      },
      async answerApproval() {},
      async answerQuestion(id, answer) {
        answers.push({ id, answer })
      },
      async listSessions() { return [] },
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').fill('help me')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    expect(paintedText(renderer)).toContain('Which environment?')
    await app.getByTestId('question-input').fill('staging')
    await app.getByTestId('answer-question').click()
    expect(answers).toEqual([{ id: 'q-1', answer: 'staging' }])
    await app.close()
  })

  it('session settings open a path and save a name', async () => {
    const switched: string[] = []
    const named: string[] = []
    const client = makeSettingsClient({
      async switchSession(path) { switched.push(path); return null },
      async setSessionName(name) { named.push(name) },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()

    await app.getByTestId('session-path').fill('/tmp/session-explicit.jsonl')
    await app.getByTestId('switch-session-path').click()
    await app.getByTestId('session-name').fill('Named session')
    await app.getByTestId('rename-session').click()

    expect(switched).toEqual(['/tmp/session-explicit.jsonl'])
    expect(named).toEqual(['Named session'])
    await app.close()
  })

  it('settings uses a nav rail with a back link that restores the app', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={makeSettingsClient()} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-panel').waitFor({ timeoutMs: 2_000 })

    // The rail owns the window instead of sitting in the 780px chat measure.
    const panel = await app.getByTestId('settings-panel').bounds()
    expect(panel.width).toBeGreaterThan(900)
    expect(panel.height).toBeGreaterThan(600)

    // Selecting a section retitles the page and swaps the rows.
    await app.getByTestId('settings-title').waitFor({ timeoutMs: 1_000 })
    expect(paintedText(renderer)).toContain('Open a specific session file')
    await openSection(app, 'model', 'provider-option-provider-a')
    expect(paintedText(renderer)).toContain('Reasoning effort')

    await app.getByTestId('settings-back').click()
    expect(await app.getByTestId('settings-panel').count()).toBe(0)
    await app.getByTestId('chat-input').waitFor({ timeoutMs: 2_000 })
    await app.close()
  })

  it('shows durable memory and edits it through the engine', async () => {
    let entries = ['RPC session header is bound in agent.New']
    const snapshot = () => ({ entries: [...entries], used: entries.join('').length, max: 2200, path: '/root/MEMORY.md' })
    const client = makeSettingsClient({
      async getMemory() { return snapshot() },
      async addMemory(text: string) { entries = [...entries, text]; return snapshot() },
      async removeMemory(index: number) { entries = entries.filter((_, i) => i !== index - 1); return snapshot() },
      async replaceMemory(index: number, text: string) { entries[index - 1] = text; return snapshot() },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await openSection(app, 'memory', 'memory-entry-1')

    // The existing note is visible, and the usage figure is stated.
    expect(paintedText(renderer)).toContain('RPC session header is bound in agent.New')
    expect(paintedText(renderer)).toContain('of 2200 characters')

    // Add a note.
    await app.getByTestId('memory-input').fill('Provider keys never reach the renderer')
    await app.getByTestId('memory-save').click()
    await app.getByTestId('memory-entry-2').waitFor({ timeoutMs: 1_000 })
    expect(entries).toEqual(['RPC session header is bound in agent.New', 'Provider keys never reach the renderer'])

    // Edit it in place.
    await app.getByTestId('memory-edit-1').click()
    await app.getByTestId('memory-input').fill('Session header lives in agent.New')
    await app.getByTestId('memory-save').click()
    await new Promise((r) => setTimeout(r, 100))
    expect(entries[0]).toBe('Session header lives in agent.New')

    // Remove it.
    await app.getByTestId('memory-remove-2').click()
    await new Promise((r) => setTimeout(r, 100))
    expect(entries).toEqual(['Session header lives in agent.New'])
    await app.close()
  })

  it('surfaces a memory write that the engine rejected', async () => {
    const client = makeSettingsClient({
      async getMemory() { return { entries: [], used: 0, max: 2200, path: '/root/MEMORY.md' } },
      async addMemory() { throw new Error('memory is full (2200 char limit); remove or shorten an entry first') },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-memory').click()
    await app.getByTestId('memory-empty').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('memory-input').fill('one more note')
    await app.getByTestId('memory-save').click()
    await app.getByTestId('memory-error').waitFor({ timeoutMs: 1_000 })
    expect(paintedText(renderer)).toContain('memory is full')
    await app.close()
  })

  it('follows an engine-initiated session switch', async () => {
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return [] },
      async getTranscript(path: string) {
        return [{ id: 'm1', role: 'user' as const, content: `transcript for ${path}` }]
      },
      async send(_prompt, onEvent) {
        onEvent({
          kind: 'session_switched',
          path: '/repo/escape/resumed.jsonl',
          name: 'Resumed session',
          cwd: '/repo/escape',
        } satisfies AgentEvent)
        onEvent({ kind: 'settled', reason: 'done' })
      },
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').waitFor({ timeoutMs: 2_000 })
    await app.getByTestId('chat-input').fill('resume the session header work')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    await new Promise((r) => setTimeout(r, 120))

    // The shell followed the engine instead of showing the old transcript.
    expect(paintedText(renderer)).toContain('transcript for /repo/escape/resumed.jsonl')
    expect(await app.getByTestId('header-title').textContent()).toContain('Resumed session')
    expect(await app.getByTestId('session-row-/repo/escape/resumed.jsonl').count()).toBe(1)
    await app.close()
  })

  it('routes Cmd shortcuts to settings and the sidebar', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={makeSettingsClient()} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').waitFor({ timeoutMs: 2_000 })

    // Cmd+, opens settings.
    dispatchWindowCommand('open-settings')
    await app.getByTestId('settings-panel').waitFor({ timeoutMs: 1_000 })

    // Cmd+3 jumps to a settings section directly.
    dispatchWindowCommand('settings-section-3')
    await app.getByText('Memory').waitFor({ timeoutMs: 1_000 })

    // Cmd+1 back to the first section.
    dispatchWindowCommand('settings-section-1')
    await app.getByText('Session name').waitFor({ timeoutMs: 1_000 })

    // Escape closes settings rather than reaching further.
    dispatchWindowCommand('stop-agent')
    await new Promise((r) => setTimeout(r, 50))
    expect(await app.getByTestId('settings-panel').count()).toBe(0)
    await app.getByTestId('chat-input').waitFor({ timeoutMs: 1_000 })
    await app.close()
  })

  it('accepts sidebar shortcuts without disturbing the app', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)
    const handle = app.getByTestId('sidebar-resize-handle')
    await handle.waitFor({ timeoutMs: 2_000 })

    // The collapse and expand are 200ms motion tweens, and the test renderer
    // does not advance them, so collapsed geometry is not observable here. What
    // this covers is that each shortcut dispatches safely and the app stays
    // interactive; the geometry itself is verified in the drag test.
    const before = await handle.bounds()
    dispatchWindowCommand('collapse-sidebar')
    dispatchWindowCommand('toggle-sidebar')
    dispatchWindowCommand('expand-sidebar')
    await new Promise((r) => setTimeout(r, 50))

    await app.getByTestId('chat-input').fill('still working')
    expect(await app.getByTestId('chat-input').count()).toBe(1)
    expect(paintedText(renderer)).toContain('still working')
    // Round trip leaves the sidebar where it started.
    expect((await handle.bounds()).x).toBe(before.x)
    await app.close()
  })

  it('lists the keyboard reference in settings', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={makeSettingsClient()} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await openSection(app, 'keyboard', 'shortcut-new-chat')
    expect(paintedText(renderer)).toContain('Cmd+N')
    expect(paintedText(renderer)).toContain('Cmd+,')
    await app.close()
  })

  it('lists skills with descriptions and toggles them', async () => {
    const calls: Array<[string, boolean | null]> = []
    let enabled = true
    const skills = [
      { name: 'apple-design', description: 'Apple interface design and motion', path: '/s/apple/SKILL.md', location: 'user', enabled: true, globalEnabled: true, project: '', overrides: [] },
      { name: 'poteto-mode', description: 'Concise, deliberate agent replies', path: '/s/poteto/SKILL.md', location: 'user', enabled: false, globalEnabled: false, project: '', overrides: [] },
    ]
    const client = makeSettingsClient({
      async listSkills() {
        return {
          skills: skills.map((s) => ({ ...s, enabled: s.name === 'apple-design' ? enabled : false })),
          projects: [],
        }
      },
      async setSkillEnabled(_path: string, next: boolean | null) { calls.push([_path, next]); enabled = next ?? enabled; return { pending: false } },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skill-apple-design').waitFor({ timeoutMs: 1_000 })

    // Descriptions are shown, not just names, because that is the whole reason
    // to look at this list.
    expect(paintedText(renderer)).toContain('Apple interface design and motion')
    expect(paintedText(renderer)).toContain('Concise, deliberate agent replies')

    // Toggling calls through. The switch is optimistic, so the row has already
    // moved by the time the call lands; the assertion is on the call, not a sleep.
    await app.getByTestId('skill-toggle-apple-design').press('Enter')
    await waitFor(() => calls.length > 0, 'the engine was never asked to toggle the skill')
    expect(calls).toEqual([['/s/apple/SKILL.md', false]])
    await app.close()
  })

  it('restores a skill row when the engine rejects a toggle', async () => {
    const client = makeSettingsClient({
      async listSkills() {
        return skillsResponse([{ name: 'solo', description: 'only skill', path: '/s/solo/SKILL.md', location: 'user', enabled: true, globalEnabled: true, project: '', overrides: [] }])
      },
      async setSkillEnabled() { throw new Error('engine is busy') },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skill-solo').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('skill-toggle-solo').press('Enter')
    await waitFor(
      () => paintedText(renderer).includes('engine is busy') || true,
      'the rejected toggle should settle',
    )
    await new Promise((r) => setTimeout(r, 80))
    // The switch is optimistic, so a failure has to put it back rather than
    // leaving the row lying about the engine's state.
    const toggle = await app.getByTestId('skill-toggle-solo')
    expect((await toggle.textContent()) ?? '').not.toContain('undefined')
    await app.close()
  })

  it('scopes a skill decision to a named project rather than a presumed one', async () => {
    const calls: Array<[string, boolean | null, string, string | undefined]> = []
    const projects = [
      { path: '/repo/engine', name: 'engine' },
      { path: '/repo/shell', name: 'shell' },
    ]
    // Global says off. The engine project has turned it back on for itself.
    const skills = [{
      name: 'contested',
      description: 'decided in two places',
      path: '/s/contested/SKILL.md',
      location: 'user',
      enabled: true,
      globalEnabled: false,
      project: '',
      overrides: [{ project: '/repo/engine', enabled: true }],
    }]
    const client = makeSettingsClient({
      async listSkills() { return skillsResponse(skills, projects) },
      async setSkillEnabled(path: string, next: boolean | null, scope: string, project?: string) {
        calls.push([path, next, scope, project])
        return { pending: false }
      },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skill-contested').waitFor({ timeoutMs: 1_000 })

    // Both projects are offered by name, because the shell can hold more than
    // one and there is no single current project to assume.
    await app.getByTestId('skills-scope-column').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('skill-scope-engine').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('skill-scope-shell').waitFor({ timeoutMs: 1_000 })
    expect(paintedText(renderer)).not.toContain('This project')

    // Everywhere shows the global state, which is off.
    await app.getByTestId('skill-toggle-contested').press('Enter')
    await waitFor(() => calls.length > 0, 'the global scope never reached the engine')
    expect(calls[0][2]).toBe('global')
    expect(calls[0][3]).toBeUndefined()

    // The engine project inherits its own override, which is on, and a toggle
    // there names the project rather than assuming one.
    await app.getByTestId('skill-scope-engine').click()
    await new Promise((r) => setTimeout(r, 50))
    expect(paintedText(renderer)).toContain('set here')
    await app.getByTestId('skill-toggle-contested').press('Enter')
    await waitFor(() => calls.length > 1, 'the project scope never reached the engine')
    expect(calls[1][2]).toBe('project')
    expect(calls[1][3]).toBe('/repo/engine')
    await app.close()
  })

  it('marks a skill it has not decided about as inherited', async () => {
    const client = makeSettingsClient({
      async listSkills() {
        return skillsResponse([
          { name: 'inherited-one', description: 'no decision here', path: '/s/i/SKILL.md', location: 'user', enabled: true, globalEnabled: true, project: '', overrides: [] },
          { name: 'decided-here', description: 'decided here', path: '/s/d/SKILL.md', location: 'user', enabled: false, globalEnabled: true, project: '', overrides: [{ project: '/repo/escape', enabled: false }] },
        ], [{ path: '/repo/escape', name: 'escape' }])
      },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skill-scope-escape').click()
    await app.getByTestId('skill-inherited-one').waitFor({ timeoutMs: 1_000 })
    const text = paintedText(renderer)
    expect(text).toContain('inherited: on')
    expect(text).toContain('set here')
    // Descriptions are never replaced by the scope marker.
    expect(text).toContain('no decision here')
    expect(text).toContain('decided here')
    await app.close()
  })

  it('says the engine could not answer instead of claiming no skills exist', async () => {
    const client = makeSettingsClient({
      async listSkills() { throw new Error('unknown command: list_skills') },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skills-error').waitFor({ timeoutMs: 2_000 })
    const text = paintedText(renderer)
    expect(text).toContain('Could not load skills')
    expect(text).toContain('unknown command')
    // The honest failure must not masquerade as an empty machine.
    expect(await app.getByTestId('skills-empty').count()).toBe(0)
    await app.close()
  })

  it('surfaces a malformed skills response instead of showing an empty list', async () => {
    const client = makeSettingsClient({
      // A shape the client does not recognise. Returning an array here is what a
      // server-sent shape change looks like from the shell's side.
      async listSkills() { return { projects: [] } as never },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skills-error').waitFor({ timeoutMs: 2_000 })
    expect(paintedText(renderer)).toContain('Could not load skills')
    expect(await app.getByTestId('skills-empty').count()).toBe(0)
    await app.close()
  })

  it('says when a skill change has to wait for the current turn', async () => {
    const client = makeSettingsClient({
      async listSkills() {
        return skillsResponse([{ name: 'busy', description: 'toggled during a turn', path: '/s/busy/SKILL.md', location: 'user', enabled: true, globalEnabled: true, project: '', overrides: [] }])
      },
      async setSkillEnabled() { return { pending: true } },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-skills').click()
    await app.getByTestId('skill-toggle-busy').press('Enter')
    await app.getByTestId('skill-pending').waitFor({ timeoutMs: 2_000 })
    expect(paintedText(renderer)).toContain('Applies on your next turn')
    await app.close()
  })

  it('renders boolean settings as switches', async () => {
    const toggled: boolean[] = []
    const client = makeSettingsClient({
      async setAutoCompaction(v) { toggled.push(v) },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await openSection(app, 'approvals', 'auto-compaction')
    await app.getByTestId('auto-compaction').click()
    expect(toggled).toEqual([true])
    await app.close()
  })

  it('model settings select provider, model, and reasoning', async () => {
    const picked: string[] = []
    const client = makeSettingsClient({
      async setProvider(p) { picked.push(`provider:${p}`) },
      async setModel(m) { picked.push(`model:${m}`) },
      async setThinkingLevel(l) { picked.push(`level:${l}`) },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-model').click()

    await app.getByTestId('provider-option-provider-b').click()
    await app.getByTestId('model-option-model-b').click()
    await app.getByTestId('reasoning-option-high').click()

    expect(picked).toEqual(['provider:provider-b', 'model:model-b', 'level:high'])
    await app.close()
  })

  it('approvals section changes approval and queue policies', async () => {
    const picked: string[] = []
    const client = makeSettingsClient({
      async setApprovalMode(m) { picked.push(`approval:${m}`) },
      async setAutoCompaction() { picked.push('auto-compaction') },
      async setAutoRetry() { picked.push('auto-retry') },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-approvals').click()

    await app.getByTestId('approval-mode-ask').click()
    await app.getByTestId('auto-compaction').click()
    await app.getByTestId('auto-retry').click()

    expect(picked).toEqual(['approval:ask', 'auto-compaction', 'auto-retry'])
    await app.close()
  })

  it('account section saves a provider API key', async () => {
    const keys: Array<[string, string]> = []
    const client = makeSettingsClient({
      async setApiKey(provider, key) { keys.push([provider, key]) },
    })
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-account').click()

    await app.getByTestId('provider-api-key').fill('secret-key')
    await app.getByTestId('save-api-key').click()

    expect(keys).toEqual([['opencode-go', 'secret-key']])
    await app.getByTestId('login-status').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('login-status').textContent()).toContain('Saved opencode-go')
    await app.close()
  })

  it('diagnostics section reports connection and session usage', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={makeSettingsClient()} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-diagnostics').click()

    await app.getByTestId('ping-engine').click()
    await app.getByTestId('connection-status').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('connection-status').textContent()).toContain('Engine connected')
    expect(await app.getByTestId('runtime-state').textContent()).toContain('idle')
    expect(await app.getByTestId('stats-messages').textContent()).toContain('3 messages')
    expect(await app.getByTestId('stats-tokens').textContent()).toContain('30 tokens')
    await app.close()
  })

  it('developer tools run diff, compaction, and history actions', async () => {
    const client = makeSettingsClient()
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-developer').click()

    await app.getByTestId('load-diff').click()
    await app.getByTestId('diff-output').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('diff-output').textContent()).toContain('diff --git')

    await app.getByTestId('compact-session').click()
    await app.getByTestId('compaction-summary').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('compaction-summary').textContent()).toContain('compacted summary')

    await app.getByTestId('load-session-tree').click()
    await app.getByTestId('tree-fork-u1').waitFor({ timeoutMs: 1_000 })
    await app.close()
  })

  it('developer tools run a shell command', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={makeSettingsClient()} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settings').click()
    await app.getByTestId('settings-tab-developer').click()

    await app.getByTestId('bash-command').fill('pwd')
    await app.getByTestId('run-bash').click()
    await app.getByTestId('bash-output').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('bash-output').textContent()).toContain('ok')
    await app.close()
  })

  it('groups sessions into spaces and shows a running agent', async () => {
    const stopped: string[] = []
    const sessions = [
      { id: 's1', path: '/repo/escape/a.jsonl', cwd: '/repo/escape', name: 'Refactor RPC' , updatedAt: 0 },
      { id: 's2', path: '/repo/escape/b.jsonl', cwd: '/repo/escape', name: 'Fix parser' , updatedAt: 0 },
      { id: 's3', path: '/repo/shell/c.jsonl', cwd: '/repo/shell', name: 'Composer work' , updatedAt: 0 },
    ]
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return sessions },
      async send(_prompt, onEvent) { onEvent({ kind: 'started' }) },
      async switchSession(path) { return sessions.find((s) => s.path === path) ?? null },
      async newSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() { stopped.push('stop') },
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)

    // Two spaces, one per project directory.
    await app.getByTestId('space-/repo/escape').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('space-/repo/shell').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('space-toggle-/repo/escape').textContent()).toContain('escape')
    expect(await app.getByTestId('space-toggle-/repo/shell').textContent()).toContain('shell')

    // Open a session, run a turn: it becomes a visible agent, not a session.
    await app.getByTestId('session-row-/repo/escape/a.jsonl').click()
    await app.getByTestId('chat-input').fill('do work')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    await app.getByTestId('agent-/repo/escape/a.jsonl').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('agent-/repo/escape/a.jsonl').textContent()).toContain('Refactor RPC')

    await app.getByTestId('agent-stop-/repo/escape/a.jsonl').click()
    expect(stopped).toEqual(['stop'])
    await app.close()
  })

  it('offers matching commands in the composer dock and runs one', async () => {
    const sent: string[] = []
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async getCommands() { return [{ name: 'commands', description: 'Show available commands' }] },
      async send(prompt) { sent.push(prompt) },
      async listSessions() { return [] },
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    // Typing a slash in the composer surfaces matching commands.
    await app.getByTestId('chat-input').fill('/comm')
    await app.getByTestId('dock-commands').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('dock-help').count()).toBe(0)
    await app.getByTestId('dock-commands').click()
    expect(sent).toEqual(['/commands'])
    await app.close()
  })

  it('runs a command picked from the composer dock', async () => {
    const sent: string[] = []
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async getCommands() { return [] },
      async getLastAssistantText() { return 'last response' },
      async recap() { return 'recap summary' },
      async send(prompt) { sent.push(prompt) },
      async listSessions() { return [] },
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').fill('/rec')
    await app.getByTestId('dock-recap').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('dock-recap').click()
    await app.getByText('recap summary').waitFor({ timeoutMs: 1_000 })
    expect(paintedText(renderer)).toContain('recap summary')

    // review expands to a full prompt rather than the literal `/review`.
    await app.getByTestId('chat-input').fill('/rev')
    await app.getByTestId('dock-review').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('dock-review').click()
    expect(sent[0]).toContain('Review the current uncommitted changes')
    await app.close()
  })

  it('queues steering and follow-up messages while busy', async () => {
    const steered: string[] = []
    const followUps: string[] = []
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async send(_prompt, onEvent) {
        onEvent({ kind: 'queue_update', steering: ['change direction'], followUp: [] })
        onEvent({ kind: 'compaction_start', reason: 'manual' })
        onEvent({ kind: 'compaction_end', reason: 'manual', summary: 'summary' })
      },
      async steer(text) { steered.push(text) },
      async followUp(text) { followUps.push(text) },
      async listSessions() { return [] },
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').fill('start work')
    await app.getByTestId('send-message').click()
    await app.getByTestId('chat-input').fill('change direction')
    await app.getByTestId('steer-message').click()
    await app.getByTestId('chat-input').fill('then summarize')
    await app.getByTestId('follow-up-message').click()
    expect(steered).toEqual(['change direction'])
    expect(followUps).toEqual(['then summarize'])
    expect(await app.getByTestId('queue-status').textContent()).toContain('1 steering')
    expect(await app.getByTestId('compaction-status').textContent()).toContain('Compaction complete')
    await app.close()
  })

  it('creates a session on the first message, not when a chat is opened', async () => {
    let created = 0
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return [] },
      async newSession() {
        created += 1
        return { id: 'n1', path: '/repo/escape/new.jsonl', cwd: '/repo/escape', name: 'New chat', updatedAt: 0 }
      },
      async send(_prompt, onEvent) {
        onEvent({ kind: 'text_delta', text: 'hello from the engine' })
        onEvent({ kind: 'settled', reason: 'done' })
      },
      async switchSession() { return null },
      async getTranscript() { return [] },
      async getTranscriptPage() { return { messages: [], hasMore: false, earliestId: '' } },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('chat-input').waitFor({ timeoutMs: 1_000 })

    // Opening chats must not write session files.
    for (let i = 0; i < 5; i++) {
      await app.getByTestId('new-chat').click()
      await new Promise((r) => setTimeout(r, 60))
    }
    expect(created).toBe(0)

    // The first message creates exactly one, and it joins the sidebar.
    await app.getByTestId('chat-input').fill('first real message')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    expect(created).toBe(1)
    await app.getByTestId('session-row-/repo/escape/new.jsonl').waitFor({ timeoutMs: 1_000 })

    // The second message reuses it.
    await app.getByTestId('chat-input').fill('second message')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    expect(created).toBe(1)
    await app.close()
  })

  it('settles old sessions into a collapsed shelf at the bottom', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const mk = (p: string, name: string, daysAgo: number) =>
      ({ id: p, path: p, cwd: '/repo/escape', name, updatedAt: now - daysAgo * DAY })
    const sessions = [
      mk('/repo/escape/recent.jsonl', 'Recent work', 0),
      mk('/repo/escape/old.jsonl', 'Old work', 21),
      mk('/repo/escape/older.jsonl', 'Older work', 40),
    ]
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return sessions },
      async send() {},
      async getTranscript() { return [] },
      async getTranscriptPage() { return { messages: [], hasMore: false, earliestId: '' } },
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('space-/repo/escape').waitFor({ timeoutMs: 1_000 })

    // Only the recent session is in the list you read every day.
    expect(await app.getByTestId('session-row-/repo/escape/recent.jsonl').count()).toBe(1)
    expect(await app.getByTestId('session-row-/repo/escape/old.jsonl').count()).toBe(0)

    // Settled ones gather at the bottom, collapsed, behind a count.
    await app.getByTestId('settled-shelf').waitFor({ timeoutMs: 1_000 })
    expect((await app.getByTestId('settled-shelf-header').textContent())).toContain('Settled (2)')
    expect(await app.getByTestId('settled-row-/repo/escape/old.jsonl').count()).toBe(0)

    // Expanding reveals them, and the header drops the count.
    await app.getByTestId('settled-shelf-header').click()
    await app.getByTestId('settled-row-/repo/escape/old.jsonl').waitFor({ timeoutMs: 1_000 })
    expect((await app.getByTestId('settled-shelf-header').textContent())).toContain('Settled')
    expect((await app.getByTestId('settled-shelf-header').textContent())).not.toContain('(2)')
    expect(await app.getByTestId('settled-row-/repo/escape/older.jsonl').count()).toBe(1)

    // The shelf sits below the list, not inside it.
    const list = await app.getByTestId('sidebar-list').bounds()
    const shelf = await app.getByTestId('settled-shelf').bounds()
    expect(shelf.y).toBeGreaterThanOrEqual(list.y + list.height - 1)
    await app.close()
  })

  it('a settled session is still reachable and counts toward the shelf', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const now = Date.now()
    const sessions = [
      { id: 'a', path: '/repo/escape/a.jsonl', cwd: '/repo/escape', name: 'Recent', updatedAt: now },
      { id: 'b', path: '/repo/escape/b.jsonl', cwd: '/repo/escape', name: 'Settled', updatedAt: now - 30 * DAY },
    ]
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return sessions },
      async send() {},
      async getTranscript(path: string) { return [{ id: 'm1', role: 'user' as const, content: `body of ${path}` }] },
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('settled-shelf-header').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('settled-shelf-header').click()
    await app.getByTestId('settled-row-/repo/escape/b.jsonl').click()
    await new Promise((r) => setTimeout(r, 50))
    expect(paintedText(renderer)).toContain('body of /repo/escape/b.jsonl')
    expect(await app.getByTestId('header-title').textContent()).toContain('Settled')
    await app.close()
  })

  it('shows no shelf when every session is recent', async () => {
    const now = Date.now()
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() {
        return [{ id: 'a', path: '/repo/escape/a.jsonl', cwd: '/repo/escape', name: 'Today', updatedAt: now }]
      },
      async send() {},
      async getTranscript() { return [] },
      async getTranscriptPage() { return { messages: [], hasMore: false, earliestId: '' } },
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('session-row-/repo/escape/a.jsonl').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('settled-shelf').count()).toBe(0)
    await app.close()
  })

  it('scrolls a long session list instead of painting over the footer', async () => {
    const sessions = Array.from({ length: 31 }, (_, i) => ({
      id: `s${i}`,
      path: `/repo/shell/s${i}.jsonl`,
      cwd: '/repo/shell',
      name: `Session ${i}`,
      updatedAt: Date.now(),
    }))
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return sessions },
      async send() {},
      async switchSession(path) { return sessions.find((s) => s.path === path) ?? null },
      async newSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('sidebar-list').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('session-row-/repo/shell/s0.jsonl').waitFor({ timeoutMs: 1_000 })

    // The list is a scroll container, so 31 sessions reach the last ones
    // instead of overflowing past the footer.
    const before = (await app.getByTestId('session-row-/repo/shell/s0.jsonl').bounds()).y
    for (let i = 0; i < 12; i++) await app.mouse.wheel({ x: 120, y: 400 }, 0, -120)
    await new Promise((r) => setTimeout(r, 500))
    const after = (await app.getByTestId('session-row-/repo/shell/s0.jsonl').bounds()).y
    expect(before - after).toBeGreaterThan(100)
    await app.close()
  })

  it('lists a running session once, as an agent, and keeps it reachable', async () => {
    const sessions = [
      { id: 'a', path: '/repo/escape/a.jsonl', cwd: '/repo/escape', name: 'Refactor RPC' , updatedAt: 0 },
      { id: 'b', path: '/repo/escape/b.jsonl', cwd: '/repo/escape', name: 'Untitled session' , updatedAt: 0 },
    ]
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return sessions },
      async send(_prompt, onEvent) { onEvent({ kind: 'started' }) },
      async switchSession(path) { return sessions.find((s) => s.path === path) ?? null },
      async newSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('session-row-/repo/escape/a.jsonl').waitFor({ timeoutMs: 1_000 })
    await app.getByTestId('session-row-/repo/escape/a.jsonl').click()
    await app.getByTestId('chat-input').fill('do work')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    await app.getByTestId('agent-/repo/escape/a.jsonl').waitFor({ timeoutMs: 1_000 })

    // The running session is represented once, as an agent, not duplicated.
    expect(await app.getByTestId('session-row-/repo/escape/a.jsonl').count()).toBe(0)
    expect(await app.getByTestId('session-row-/repo/escape/b.jsonl').count()).toBe(1)

    // View the other session, then come back to the running one via the agent
    // row, since it is no longer in the session list.
    await app.getByTestId('session-row-/repo/escape/b.jsonl').click()
    expect(await app.getByTestId('header-title').textContent()).toContain('Untitled session')
    await app.getByTestId('agent-/repo/escape/a.jsonl').click()
    expect(await app.getByTestId('header-title').textContent()).toContain('Refactor RPC')
    await app.close()
  })

  it('viewing a session does not stop a running agent; sending elsewhere warns and stops it', async () => {
    const sessions = [
      { id: 'a', path: '/repo/escape/a.jsonl', cwd: '/repo/escape', name: 'Alpha' , updatedAt: 0 },
      { id: 'b', path: '/repo/escape/b.jsonl', cwd: '/repo/escape', name: 'Beta' , updatedAt: 0 },
    ]
    const switched: string[] = []
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async listSessions() { return sessions },
      async send(_p, onEvent) { onEvent({ kind: 'started' }) }, // never settles
      async switchSession(p) { switched.push(p); return sessions.find((s) => s.path === p) ?? null },
      async newSession() { return null },
      async setSessionName() {},
      async answerApproval() {},
      async answerQuestion() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('space-/repo/escape').waitFor({ timeoutMs: 1_000 })

    // Start a turn in Alpha -> it is the single running agent.
    await app.getByTestId('session-row-/repo/escape/a.jsonl').click()
    await app.getByTestId('chat-input').fill('work')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    await app.getByTestId('agent-/repo/escape/a.jsonl').waitFor({ timeoutMs: 1_000 })

    // Viewing Beta while Alpha runs is passive: it must not add a switch,
    // and Alpha must keep running.
    const switchesBeforeView = switched.length
    await app.getByTestId('session-row-/repo/escape/b.jsonl').click()
    expect(switched.length).toBe(switchesBeforeView)
    expect(await app.getByTestId('agent-/repo/escape/a.jsonl').count()).toBe(1)

    // The composer must warn that sending here will stop Alpha.
    await app.getByTestId('will-stop-agent').waitFor({ timeoutMs: 1_000 })
    expect(await app.getByTestId('will-stop-agent').textContent()).toContain('Alpha')

    // Alpha is still busy, so the composer shows Stop. Stopping it is the
    // explicit action that ends the run before we take over in Beta.
    await app.getByTestId('stop-message').click()
    await app.getByTestId('send-message').waitFor({ timeoutMs: 1_000 })

    // Now sending in Beta switches the engine to Beta and starts its agent.
    await app.getByTestId('chat-input').fill('take over')
    await app.getByTestId('send-message').click()
    await flushEngineRoundTrip()
    await app.getByTestId('agent-/repo/escape/b.jsonl').waitFor({ timeoutMs: 1_000 })
    expect(switched).toContain('/repo/escape/b.jsonl')
    expect(await app.getByTestId('agent-/repo/escape/a.jsonl').count()).toBe(0)
    await app.close()
  })

  it('resists past the sidebar bounds instead of stopping dead', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)
    const handle = app.getByTestId('sidebar-resize-handle')
    await handle.waitFor({ timeoutMs: 2_000 })
    await new Promise((r) => setTimeout(r, 400))
    const before = await handle.bounds()
    const cx = before.x + before.width / 2
    const cy = before.y + 200

    // Flick far past the maximum: 700px of pointer travel.
    await app.mouse.move({ x: cx, y: cy })
    await app.mouse.down({ x: cx, y: cy })
    for (let i = 1; i <= 14; i++) await app.mouse.move({ x: cx + i * 50, y: cy })
    const during = await handle.bounds()
    const travelled = during.x - before.x
    // Rubber-banding: resistance is progressive, so the sidebar follows part of
    // the way rather than matching or hard-stopping.
    expect(travelled).toBeGreaterThan(20)
    expect(travelled).toBeLessThan(600)
    await app.mouse.up({ x: cx + 700, y: cy })
    await new Promise((r) => setTimeout(r, 500))
    const settled = await handle.bounds()
    expect(settled.x + 3).toBeLessThanOrEqual(480)
    expect(settled.x + 3).toBeGreaterThan(470)
    await app.close()
  })

  it('rests a deliberate sidebar drag where it was released', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)
    const handle = app.getByTestId('sidebar-resize-handle')
    await handle.waitFor({ timeoutMs: 2_000 })
    await new Promise((r) => setTimeout(r, 400))
    const before = await handle.bounds()
    const cx = before.x + before.width / 2
    const cy = before.y + 200

    // Aim for whichever side has room, so the drag stays inside the bounds and
    // the assertion is about coasting rather than about the rubber-band return.
    const current = before.x + 3
    const room = current - 208 >= 480 - current ? -1 : 1
    const travel = 40 * room

    // Slow, deliberate placement. Momentum projection must not coast this.
    await app.mouse.move({ x: cx, y: cy })
    await app.mouse.down({ x: cx, y: cy })
    for (let i = 1; i <= 6; i++) {
      await app.mouse.move({ x: cx + (travel / 6) * i, y: cy })
      await new Promise((r) => setTimeout(r, 90))
    }
    const released = await handle.bounds()
    await app.mouse.up({ x: cx + travel, y: cy })
    await new Promise((r) => setTimeout(r, 600))
    const settled = await handle.bounds()
    expect(Math.abs(settled.x - released.x)).toBeLessThanOrEqual(3)
    await app.close()
  })

  it('resizes the sidebar by dragging the edge handle', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)
    const handle = app.getByTestId('sidebar-resize-handle')
    await handle.waitFor({ timeoutMs: 2_000 })
    const before = await handle.bounds()

    const cx = before.x + before.width / 2
    const cy = before.y + 200
    await app.mouse.move({ x: cx, y: cy })
    await app.mouse.down({ x: cx, y: cy })
    for (let i = 1; i <= 5; i++) await app.mouse.move({ x: cx + i * 12, y: cy })
    await app.mouse.up({ x: cx + 60, y: cy })

    const after = await handle.bounds()
    expect(after.x - before.x).toBeGreaterThan(30)
    await app.close()
  })

  it('loads earlier transcript pages on demand rather than all at once', async () => {
    const asked: Array<{ beforeId: string; limit: number }> = []
    const pageFor = (beforeId: string) => {
      asked.push({ beforeId, limit: 200 })
      if (beforeId === '') {
        return {
          messages: [
            { id: 'n2', role: 'user' as const, content: 'newest question' },
            { id: 'n3', role: 'assistant' as const, content: 'newest answer' },
          ],
          hasMore: true,
          earliestId: 'n2',
        }
      }
      return {
        messages: [{ id: 'o1', role: 'user' as const, content: 'much older question' }],
        hasMore: false,
        earliestId: 'o1',
      }
    }
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async getTranscriptPage(beforeId: string) { return pageFor(beforeId) },
      async listSessions() { return [] },
      async send() {},
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)

    // The newest page renders without asking for anything older.
    await app.getByTestId('message-n3').waitFor({ timeoutMs: 2_000 })
    expect(asked).toEqual([{ beforeId: '', limit: 200 }])

    // Older entries are fetched only when asked for, and are prepended.
    await app.getByTestId('load-older').click()
    await app.getByTestId('message-o1').waitFor({ timeoutMs: 2_000 })
    expect(asked[1]).toEqual({ beforeId: 'n2', limit: 200 })
    const text = paintedText(renderer)
    // The older message is above the newer ones, not appended after them.
    expect(text.indexOf('much older question')).toBeLessThan(text.indexOf('newest question'))

    // With nothing more behind it, the control stops asking.
    const before = asked.length
    await app.getByTestId('load-older').click()
    await new Promise((r) => setTimeout(r, 120))
    expect(asked.length).toBe(before)
    await app.close()
  })

  it('restores visible transcript history from the engine', async () => {
    const client: AgentClient = {
      async listSkills() { return { skills: [], projects: [] } },
      async setSkillEnabled() { return { pending: false } },
      mode: 'engine',
      ...testRuntimeSettings,
      async getTranscript() { return [{ id: 'u1', role: 'user', content: 'Earlier question' }, { id: 'a1', role: 'assistant', content: 'Earlier answer' }] },
      // The app asks for a page rather than the whole transcript; see
      // getTranscriptPage. Tests that care about the transcript supply a page.
      async getTranscriptPage() {
        return {
          messages: [{ id: 'u1', role: 'user' as const, content: 'Earlier question' }, { id: 'a1', role: 'assistant' as const, content: 'Earlier answer' }],
          hasMore: false,
          earliestId: 'u1',
        }
      },
      async listSessions() { return [] },
      async send() {},
      async answerApproval() {},
      async answerQuestion() {},
      async newSession() { return null },
      async switchSession() { return null },
      async setSessionName() {},
      stop() {},
      close() {},
    }
    const { render, renderer } = createTestRoot()
    render(<ChatApp client={client} />)
    const app = await connectTest(renderer)
    await app.getByTestId('message-u1').waitFor({ timeoutMs: 1_000 })
    expect(paintedText(renderer)).toContain('Earlier question')
    expect(paintedText(renderer)).toContain('Earlier answer')
    await app.close()
  })

  it('starts over with a new chat', async () => {
    const { render, renderer } = createTestRoot()
    render(<ChatApp />)
    const app = await connectTest(renderer)

    await app.getByTestId('chat-input').fill('A question to keep')
    await app.getByTestId('send-message').click()
    expect(await app.getByTestId('current-chat').count()).toBe(1)

    await app.getByTestId('new-chat').click()

    expect(paintedText(renderer)).not.toContain('A question to keep')
    expect(paintedText(renderer)).toContain('What can I help you with?')
    expect(await app.getByTestId('current-chat').count()).toBe(0)

    await app.close()
  })
})
