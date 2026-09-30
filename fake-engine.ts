/**
 * Scripted in-memory AgentClient for tests. It behaves like the engine at
 * the RPC boundary (async methods, event callbacks, errors) without spawning
 * a process, so UI tests exercise real flows against canned engine state.
 */
import type {
  AgentClient,
  AgentEvent,
  AgentState,
  BashResult,
  CommandSummary,
  Diagnostics,
  ExportResult,
  ForkMessage,
  MemorySnapshot,
  ModelInfo,
  Project,
  ProviderSummary,
  SessionStats,
  SessionSummary,
  VcsStatus,
  SessionTreeNode,
  SkillProject,
  SkillScope,
  SkillSummary,
  TranscriptMessage,
} from './agent-client'

export interface FakeToolCall {
  name: string
  output?: string
  isError?: boolean
}

export class FakeEngine implements AgentClient {
  readonly mode = 'engine' as const
  calls: { method: string; args: unknown[] }[] = []
  closed = false
  defaultProject = ''
  stopped = false
  sent: { prompt: string; attachments: string[] }[] = []

  state: AgentState = {
    state: 'idle',
    sessionId: 'sess-1',
    sessionFile: '/tmp/sess-1.jsonl',
    cwd: '/Users/tester/projects/alpha',
    model: 'test-model-a',
    provider: 'opencode-go',
    thinkingLevel: 'medium',
    titleModel: '',
    defaultProject: '',
    apiEndpointBaseURL: 'https://api.openai.com/v1',
    approvalMode: 'auto',
    autoCompaction: false,
    autoRetry: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    maxTokens: 0,
  }
  models: ModelInfo[] = [
    { id: 'test-model-a', name: 'Test Model A', provider: 'TestCo' },
    { id: 'test-model-b', name: 'Test Model B', provider: 'TestCo' },
  ]
  providers: ProviderSummary[] = [
    { id: 'opencode-go', name: 'OpenCode Go', configured: true },
    { id: 'opencode-zen', name: 'OpenCode Zen', configured: false },
    { id: 'codex', name: 'Codex', configured: false },
    { id: 'api', name: 'OpenAI-compatible API', configured: false },
  ]
  levels = ['off', 'low', 'medium', 'high']
  sessions: SessionSummary[] = []
  transcripts: Record<string, TranscriptMessage[]> = {}
  diff = ''
  /** Working tree reported by vcsStatus(). Tests overwrite this. */
  vcs: VcsStatus = {
    isRepo: true,
    refName: 'main',
    hasChanges: false,
    staged: [],
    unstaged: [],
    insertions: 0,
    deletions: 0,
  }
  /** Fails the next vcs mutation with this message, to exercise error paths. */
  failVcsWith: string | null = null
  commands: CommandSummary[] = []
  projects: Project[] = [{ path: '/Users/tester/projects/alpha' }]

  /** Reply streamed back by send(), split into text_delta chunks. */
  replyText = 'fake engine reply'
  /** Tool calls emitted before the reply text. */
  toolScript: FakeToolCall[] = []
  /** Turn ids the fake hands out, so a test can assert the shell adopted them. */
  turnIds: string[] = []
  /**
   * Delay between the last tool call and `turn_end`. Lets a turn's reported
   * span differ from the span of its tool timings, which is what separates
   * "the shell used the engine's turn" from "the shell fell back to summing
   * tool calls".
   */
  turnTailDelayMs = 0
  private turnSeq = 0
  /** When set, send() pauses with an approval request until answered. */
  approvalScript: { toolCallId: string; toolName: string } | null = null
  /** When set, send() pauses with a question until answered. */
  questionScript: { questionId: string; question: string } | null = null
  /** send() emits this error event instead of replying. */
  sendError: string | null = null
  /** Methods that reject, keyed by method name. */
  failures: Record<string, string> = {}

  answeredApprovals: { toolCallId: string; approved: boolean }[] = []
  answeredQuestions: { questionId: string; answer: string }[] = []

  /** When true, send() waits until releaseSend() before streaming. */
  pauseSend = false
  private sendGate: Array<() => void> = []
  private sendWaiter: (() => void) | null = null

  releaseSend(): void {
    const gate = this.sendGate
    this.sendGate = []
    for (const resolve of gate) resolve()
  }
  private fail(method: string): void {
    if (this.failures[method]) throw new Error(this.failures[method])
  }

  async send(
    prompt: string,
    attachments: string[],
    onEvent: (event: AgentEvent) => void,
  ): Promise<void> {
    this.onEvent = onEvent
    this.calls.push({ method: 'send', args: [prompt] })
    this.sent.push({ prompt, attachments })
    // Mirror the engine's real lifecycle order: agent_start, then the named
    // turn. Tests that assert turn boundaries depend on this id existing.
    const turnId = `fake-turn-${++this.turnSeq}`
    this.turnIds.push(turnId)
    onEvent({ kind: 'started' })
    onEvent({ kind: 'turn_start', turnId })
    let n = 0
    for (const tool of this.toolScript) {
      const id = `tool-${n++}`
      onEvent({ kind: 'tool_start', toolCallId: id, toolName: tool.name })
      onEvent({
        kind: 'tool_end',
        toolCallId: id,
        toolName: tool.name,
        output: tool.output ?? '',
        isError: tool.isError ?? false,
      })
    }
    if (this.sendError) {
      onEvent({ kind: 'error', message: this.sendError })
      onEvent({ kind: 'turn_end', turnId, reason: 'error', state: 'error' })
      onEvent({ kind: 'agent_end' })
      return
    }
    if (this.pauseSend) {
      await new Promise<void>((resolve) => {
        this.sendGate.push(resolve)
      })
    }
    if (this.approvalScript) {
      onEvent({
        kind: 'approval',
        toolCallId: this.approvalScript.toolCallId,
        toolName: this.approvalScript.toolName,
        args: {},
      })
      await new Promise<void>((resolve) => {
        this.sendWaiter = resolve
      })
    }
    if (this.questionScript) {
      onEvent({
        kind: 'question',
        questionId: this.questionScript.questionId,
        question: this.questionScript.question,
      })
      await new Promise<void>((resolve) => {
        this.sendWaiter = resolve
      })
    }
    for (const chunk of this.replyText.match(/.{1,12}/gs) ?? []) {
      onEvent({ kind: 'text_delta', text: chunk })
    }
    // A stop mid-turn ends the turn as interrupted, which is a different
    // outcome from a completed one and must not be reported as either.
    if (this.turnTailDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.turnTailDelayMs)
      })
    }
    const interrupted = this.stopped
    this.stopped = false
    onEvent({
      kind: 'turn_end',
      turnId,
      reason: interrupted ? 'stopped' : 'done',
      state: interrupted ? 'interrupted' : 'completed',
    })
    onEvent({ kind: 'settled', reason: interrupted ? 'stopped' : 'done' })
    onEvent({ kind: 'agent_end' })
  }

  async steer(prompt: string): Promise<void> {
    this.calls.push({ method: 'steer', args: [prompt] })
  }

  async followUp(prompt: string): Promise<void> {
    this.calls.push({ method: 'followUp', args: [prompt] })
  }

  /** Branch name reported by `git rev-parse --abbrev-ref HEAD`. Empty hides the header chip. */
  /**
   * Design Mode phases the fake reports, in order, so a test can drive the
   * composer's phase list without a real run. Each entry is the phase name and
   * the detail the run would have reported.
   */
  designScript: { phase: string; detail: string }[] = []
  /**
   * The handler the last send or startDesign installed. A design run is not a
   * send, so its events need somewhere to go that outlives one call.
   */
  onEvent: (event: AgentEvent) => void = () => {}
  /** What the last design run finished with. */
  designResult = { passed: true, repairs: 0, verdict: 'pass', why: '' }
  /** Set to have a design run finish with an error instead. */
  failDesignWith = ''
  private designWaiter: (() => void) | null = null

  async startDesign(request: string, onEvent?: (event: AgentEvent) => void): Promise<void> {
    if (onEvent) this.onEvent = onEvent
    this.calls.push({ method: 'startDesign', args: [request] })
    this.fail('startDesign')
    this.sent.push({ prompt: request, attachments: [] })
    for (const step of this.designScript) {
      if (this.designWaiter) {
        await new Promise<void>((resolve) => {
          this.designWaiter = resolve
        })
        this.designWaiter = null
      }
      this.onEvent({ kind: 'design_progress', phase: step.phase, pass: 0, detail: step.detail })
    }
  }

  async cancelDesign(): Promise<void> {
    this.calls.push({ method: 'cancelDesign', args: [] })
    this.releaseDesign()
  }

  /** Lets a paused design run finish, so a test can observe the middle. */
  releaseDesign(): void {
    const w = this.designWaiter
    this.designWaiter = null
    w?.()
  }

  /** Emits the outcome of a design run. */
  finishDesign(): void {
    if (this.failDesignWith) {
      this.onEvent({
        kind: 'design_done', passed: false, repairs: 0, verdict: '', why: '',
        shots: [], error: this.failDesignWith,
      })
      return
    }
    this.onEvent({
      kind: 'design_done',
      passed: this.designResult.passed,
      repairs: this.designResult.repairs,
      verdict: this.designResult.verdict,
      why: this.designResult.why,
      shots: this.designResult.passed
        ? [
            { viewport: 'shot-1440x1000', path: '/tmp/desktop.png' },
            { viewport: 'shot-390x844', path: '/tmp/mobile.png' },
          ]
        : [],
      error: '',
    })
  }

  branch = 'main'

  async bash(command: string): Promise<BashResult> {
    this.calls.push({ method: 'bash', args: [command] })
    if (command.includes('rev-parse --abbrev-ref HEAD')) {
      return { output: this.branch, exitCode: 0, truncated: false }
    }
    return { output: '', exitCode: 0, truncated: false }
  }

  async abortBash(): Promise<void> {}

  async getDiff(): Promise<string> {
    this.calls.push({ method: 'getDiff', args: [] })
    this.fail('getDiff')
    return this.diff
  }

  /** Per-file patches served by vcsFileDiff, keyed by path. */
  fileDiffs: Record<string, string> = {}

  /** Text handed to copyToClipboard, so tests can assert what would be copied. */
  copied: string[] = []

  /** Makes copyToClipboard reject, as a stale engine would. */
  failCopyWith: string | null = null

  async copyToClipboard(text: string): Promise<void> {
    this.calls.push({ method: 'copyToClipboard', args: [text] })
    if (this.failCopyWith) throw new Error(this.failCopyWith)
    this.copied.push(text)
  }

  async vcsFileDiff(path: string): Promise<string> {
    this.calls.push({ method: 'vcsFileDiff', args: [path] })
    return this.fileDiffs[path] ?? ''
  }

  async vcsStatus(): Promise<VcsStatus> {
    this.calls.push({ method: 'vcsStatus', args: [] })
    return this.vcs
  }

  async vcsStage(paths: string[] = []): Promise<void> {
    this.calls.push({ method: 'vcsStage', args: [paths] })
    if (this.failVcsWith) throw new Error(this.failVcsWith)
  }

  async vcsUnstage(paths: string[] = []): Promise<void> {
    this.calls.push({ method: 'vcsUnstage', args: [paths] })
    if (this.failVcsWith) throw new Error(this.failVcsWith)
  }

  async vcsCommit(message: string, paths: string[] = []): Promise<void> {
    this.calls.push({ method: 'vcsCommit', args: [message, paths] })
    if (this.failVcsWith) throw new Error(this.failVcsWith)
  }

  async listSkills(): Promise<{ skills: SkillSummary[]; projects: SkillProject[] }> {
    return { skills: [], projects: [] }
  }

  async setSkillEnabled(): Promise<{ pending: boolean }> {
    return { pending: false }
  }

  async getMemory(): Promise<MemorySnapshot> {
    return { entries: [], used: 0, max: 2200, path: '' }
  }

  async addMemory(): Promise<MemorySnapshot> {
    return { entries: [], used: 0, max: 2200, path: '' }
  }

  async replaceMemory(): Promise<MemorySnapshot> {
    return { entries: [], used: 0, max: 2200, path: '' }
  }

  async removeMemory(): Promise<MemorySnapshot> {
    return { entries: [], used: 0, max: 2200, path: '' }
  }

  async answerApproval(toolCallId: string, approved: boolean): Promise<void> {
    this.calls.push({ method: 'answerApproval', args: [toolCallId, approved] })
    this.fail('answerApproval')
    this.answeredApprovals.push({ toolCallId, approved })
    this.approvalScript = null
    this.sendWaiter?.()
    this.sendWaiter = null
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    this.calls.push({ method: 'answerQuestion', args: [questionId, answer] })
    this.fail('answerQuestion')
    this.answeredQuestions.push({ questionId, answer })
    this.questionScript = null
    this.sendWaiter?.()
    this.sendWaiter = null
  }

  async listSessions(): Promise<SessionSummary[]> {
    this.calls.push({ method: 'listSessions', args: [] })
    this.fail('listSessions')
    return this.sessions.map((s) => ({ ...s }))
  }

  async newSession(): Promise<SessionSummary | null> {
    this.calls.push({ method: 'newSession', args: [] })
    this.fail('newSession')
    const created: SessionSummary = {
      id: `sess-${this.sessions.length + 1}`,
      path: `/tmp/sess-${this.sessions.length + 1}.jsonl`,
      cwd: this.state.cwd,
      name: 'Untitled session',
      updatedAt: Date.now(),
    }
    this.sessions.unshift(created)
    this.transcripts[created.path] = []
    return created
  }

  async switchSession(path: string): Promise<SessionSummary | null> {
    this.calls.push({ method: 'switchSession', args: [path] })
    return this.sessions.find((s) => s.path === path) ?? null
  }

  async setSessionName(): Promise<void> {}

  async getState(): Promise<AgentState> {
    this.calls.push({ method: 'getState', args: [] })
    this.fail('getState')
    return { ...this.state }
  }

  async ping(): Promise<boolean> {
    return true
  }

  async getProviders(): Promise<ProviderSummary[]> {
    this.calls.push({ method: 'getProviders', args: [] })
    this.fail('getProviders')
    return this.providers.map((p) => ({ ...p }))
  }

  async getCommands(): Promise<CommandSummary[]> {
    return [...this.commands]
  }

  async getSessionStats(): Promise<SessionStats | null> {
    return null
  }

  async listProjects(): Promise<{ projects: Project[]; current: string }> {
    this.calls.push({ method: 'listProjects', args: [] })
    this.fail('listProjects')
    return { projects: this.projects.map((p) => ({ ...p })), current: this.state.cwd }
  }

  /**
   * What addProject reports back, so a test can exercise the engine's duplicate
   * case. Set it directly; unset, a real project is appended and reported added.
   */
  addProjectResult: { project: Project; added: boolean } | null = null

  async addProject(path: string): Promise<{ project: Project; added: boolean }> {
    this.calls.push({ method: 'addProject', args: [path] })
    this.fail('addProject')
    if (this.addProjectResult) return this.addProjectResult
    // Append so the picker's refresh has something to show. A stub that
    // returned a fixed empty path would make the refresh untestable.
    if (!this.projects.some((p) => p.path === path)) {
      this.projects = [...this.projects, { path }]
    }
    return { project: { path }, added: true }
  }

  async removeProject(): Promise<{ removed: boolean }> {
    return { removed: false }
  }

  async switchProject(path: string): Promise<{ cwd: string }> {
    this.calls.push({ method: 'switchProject', args: [path] })
    this.fail('switchProject')
    this.state = { ...this.state, cwd: path }
    return { cwd: path }
  }

  async getDiagnostics(): Promise<Diagnostics | null> {
    return null
  }

  async writeDiagnostics(): Promise<{ path: string; report: string } | null> {
    return null
  }

  async getTranscript(): Promise<TranscriptMessage[]> {
    return []
  }

  async getTranscriptPage(
    beforeId: string,
    limit: number,
    sessionPath?: string,
  ): Promise<{ messages: TranscriptMessage[]; hasMore: boolean; earliestId: string }> {
    this.calls.push({ method: 'getTranscriptPage', args: [sessionPath ?? ''] })
    this.fail('getTranscriptPage')
    const messages = (sessionPath ? this.transcripts[sessionPath] : []) ?? []
    void beforeId
    void limit
    return { messages: messages.map((m) => ({ ...m })), hasMore: false, earliestId: '' }
  }

  async getLastAssistantText(): Promise<string> {
    return ''
  }

  async getForkMessages(): Promise<ForkMessage[]> {
    return []
  }

  async getTree(): Promise<SessionTreeNode[]> {
    return []
  }

  async fork(): Promise<string | null> {
    return null
  }

  async undo(): Promise<string | null> {
    return null
  }

  async cloneSession(): Promise<string | null> {
    return null
  }

  async exportHtml(): Promise<ExportResult | null> {
    return null
  }

  async compact(): Promise<string> {
    return ''
  }

  async snapcompact(): Promise<string> {
    return ''
  }

  async recap(): Promise<string> {
    return ''
  }

  async getModels(): Promise<ModelInfo[]> {
    this.calls.push({ method: 'getModels', args: [] })
    this.fail('getModels')
    return this.models.map((m) => ({ ...m }))
  }

  async getThinkingLevels(): Promise<string[]> {
    this.fail('getThinkingLevels')
    return [...this.levels]
  }

  async setModel(model: string): Promise<void> {
    this.calls.push({ method: 'setModel', args: [model] })
    this.fail('setModel')
    this.state = { ...this.state, model }
  }

  async setProvider(provider: string): Promise<void> {
    this.calls.push({ method: 'setProvider', args: [provider] })
    this.fail('setProvider')
    this.state = { ...this.state, provider }
  }

  async setApiKey(provider: 'opencode-go' | 'opencode-zen', apiKey: string): Promise<void> {
    this.calls.push({ method: 'setApiKey', args: [provider, apiKey] })
    this.fail('setApiKey')
    this.providers = this.providers.map((p) =>
      p.id === provider ? { ...p, configured: true } : p,
    )
    void apiKey
  }

  async removeApiKey(provider: 'opencode-go' | 'opencode-zen' | 'api'): Promise<void> {
    this.calls.push({ method: 'removeApiKey', args: [provider] })
    this.fail('removeApiKey')
    this.providers = this.providers.map((p) =>
      p.id === provider ? { ...p, configured: false } : p,
    )
  }

  async setApiEndpoint(baseURL: string, apiKey: string): Promise<void> {
    this.calls.push({ method: 'setApiEndpoint', args: [baseURL, apiKey] })
    this.fail('setApiEndpoint')
    this.providers = this.providers.map((p) =>
      p.id === 'api' ? { ...p, configured: true } : p,
    )
    void apiKey
  }

  async setDefaultProject(path: string): Promise<{ defaultProject: string; cwd: string }> {
    this.calls.push({ method: 'setDefaultProject', args: [path] })
    this.fail('setDefaultProject')
    this.defaultProject = path
    if (path !== '') this.state = { ...this.state, cwd: path }
    return { defaultProject: this.defaultProject, cwd: this.state.cwd }
  }

  async setTitleModel(model: string): Promise<void> {
    this.calls.push({ method: 'setTitleModel', args: [model] })
    this.fail('setTitleModel')
    this.state = { ...this.state, titleModel: model }
  }

  async setApprovalMode(mode: 'auto' | 'ask'): Promise<void> {
    this.calls.push({ method: 'setApprovalMode', args: [mode] })
    this.fail('setApprovalMode')
    this.state = { ...this.state, approvalMode: mode }
  }

  async setAutoCompaction(): Promise<void> {}

  async setAutoRetry(): Promise<void> {}

  async abortRetry(): Promise<void> {}

  async setMaxTokens(): Promise<void> {}

  async setSteeringMode(mode: string): Promise<void> {
    this.calls.push({ method: 'setSteeringMode', args: [mode] })
    this.fail('setSteeringMode')
    this.state = { ...this.state, steeringMode: mode }
  }

  async setFollowUpMode(mode: string): Promise<void> {
    this.calls.push({ method: 'setFollowUpMode', args: [mode] })
    this.fail('setFollowUpMode')
    this.state = { ...this.state, followUpMode: mode }
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.calls.push({ method: 'setThinkingLevel', args: [level] })
    this.fail('setThinkingLevel')
    this.state = { ...this.state, thinkingLevel: level }
  }

  stop(): void {
    this.stopped = true
  }

  close(): void {
    this.closed = true
  }
}
