import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type AgentEvent =
  | { kind: 'started' }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; toolCallId: string; toolName: string }
  | { kind: 'tool_end'; toolCallId: string; toolName: string; output: string; isError: boolean }
  | { kind: 'approval'; toolCallId: string; toolName: string; args: Readonly<Record<string, unknown>> }
  | { kind: 'question'; questionId: string; question: string }
  | { kind: 'error'; message: string }
  | { kind: 'session_switched'; path: string; name: string; cwd: string }
  | { kind: 'bash_delta'; text: string }
  | { kind: 'retry_start'; attempt: number; maxAttempts: number; delayMs: number }
  | { kind: 'retry_end'; success: boolean; attempt: number }
  | { kind: 'queue_update'; steering: string[]; followUp: string[] }
  | { kind: 'compaction_start'; reason: string }
  | { kind: 'compaction_end'; reason: string; summary: string }
  | { kind: 'message_end'; messageId: string }
  | { kind: 'turn_end' }
  | { kind: 'agent_end' }
  | { kind: 'settled'; reason: string }

export interface AgentClient {
  readonly mode: 'engine' | 'local'
  send(prompt: string, onEvent: (event: AgentEvent) => void): Promise<void>
  steer(prompt: string): Promise<void>
  followUp(prompt: string): Promise<void>
  bash(command: string, onDelta: (text: string) => void): Promise<BashResult>
  abortBash(): Promise<void>
  getDiff(paths?: string[]): Promise<string>
  listSkills(): Promise<{ skills: SkillSummary[]; projects: SkillProject[] }>
  setSkillEnabled(path: string, enabled: boolean | null, scope: SkillScope, project?: string): Promise<{ pending: boolean }>
  getMemory(): Promise<MemorySnapshot>
  addMemory(text: string): Promise<MemorySnapshot>
  replaceMemory(index: number, text: string): Promise<MemorySnapshot>
  removeMemory(index: number): Promise<MemorySnapshot>
  answerApproval(toolCallId: string, approved: boolean): Promise<void>
  answerQuestion(questionId: string, answer: string): Promise<void>
  listSessions(): Promise<SessionSummary[]>
  newSession(): Promise<SessionSummary | null>
  switchSession(path: string): Promise<SessionSummary | null>
  setSessionName(name: string): Promise<void>
  getState(): Promise<AgentState>
  ping(): Promise<boolean>
  getProviders(): Promise<ProviderSummary[]>
  getCommands(): Promise<CommandSummary[]>
  getSessionStats(): Promise<SessionStats | null>
  getTranscript(sessionPath?: string): Promise<TranscriptMessage[]>
  getLastAssistantText(): Promise<string>
  getForkMessages(): Promise<ForkMessage[]>
  getTree(): Promise<SessionTreeNode[]>
  fork(entryId: string): Promise<string | null>
  undo(): Promise<string | null>
  cloneSession(): Promise<string | null>
  exportHtml(outputPath?: string): Promise<ExportResult | null>
  compact(): Promise<string>
  snapcompact(): Promise<string>
  recap(): Promise<string>
  getModels(): Promise<string[]>
  getThinkingLevels(): Promise<string[]>
  setModel(model: string): Promise<void>
  setProvider(provider: string): Promise<void>
  setApiKey(provider: 'opencode-go' | 'opencode-zen', apiKey: string): Promise<void>
  setApprovalMode(mode: 'auto' | 'ask'): Promise<void>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  abortRetry(): Promise<void>
  setMaxTokens(maxTokens: number): Promise<void>
  setSteeringMode(mode: string): Promise<void>
  setFollowUpMode(mode: string): Promise<void>
  setThinkingLevel(level: string): Promise<void>
  stop(): void
  close(): void
}

type JsonRecord = Record<string, unknown>

export type ForkMessage = {
  entryId: string
  text: string
}

export type SessionTreeNode = {
  entryId: string
  role: 'user' | 'assistant' | 'other'
  text: string
  children: SessionTreeNode[]
}

export type BashResult = {
  output: string
  exitCode: number
  truncated: boolean
}

export type TranscriptMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export type SessionSummary = {
  id: string
  path: string
  cwd: string
  name: string
  /** Last-modified time in epoch milliseconds, from the engine. The sidebar's
   *  settled shelf is derived from it, so it is not optional in practice. */
  updatedAt: number
}

export type SkillSummary = {
  name: string
  description: string
  path: string
  location: string
  /** Effective state for this project: the project decision, else the global one. */
  enabled: boolean
  /** The global list, which applies to every project. */
  globalEnabled: boolean
  /** The project that owns this skill, when it is not a user level one. */
  project: string
  /** Decisions made by individual projects. Empty means everywhere inherits. */
  overrides: Array<{ project: string; enabled: boolean }>
}

/** A project the engine can scope a skill decision to. */
export type SkillProject = { path: string; name: string }

export type SkillScope = 'global' | 'project'

export type MemorySnapshot = {
  entries: string[]
  used: number
  max: number
  path: string
}

export type ProviderSummary = {
  id: string
  name: string
  configured: boolean
}

export type CommandSummary = {
  name: string
  description: string
}

export type ExportResult = {
  path: string
}

export type SessionStats = {
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextTokens: number | null
  contextWindow: number
  contextPercent: number | null
}

export type AgentState = {
  state: string
  sessionId: string
  sessionFile: string
  cwd: string
  model: string
  provider: string
  thinkingLevel: string
  approvalMode: string
  autoCompaction: boolean
  autoRetry: boolean
  steeringMode: string
  followUpMode: string
  maxTokens: number
}

type PendingResponse = {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function readNumber(record: JsonRecord, key: string): number {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readNumberOrNull(record: JsonRecord, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readArgs(record: JsonRecord): Readonly<Record<string, unknown>> {
  const value = record.args
  return isRecord(value) ? value : {}
}

/** Last path segment, for naming a project from its cwd. */
function projectName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function readSessionSummary(value: unknown): SessionSummary | null {
  if (!isRecord(value)) return null
  const record = isRecord(value.session) ? value.session : value
  const id = readString(record, 'id')
  const path = readString(record, 'path') ?? (typeof value.path === 'string' ? value.path : null)
  const cwd = readString(record, 'cwd')
  if (!id || !path || !cwd) return null
  return {
    id,
    path,
    cwd,
    name: readString(record, 'name') ?? '',
    updatedAt: typeof record.mtime === 'number' ? record.mtime : 0,
  }
}

function parseEvent(value: unknown): AgentEvent | null {
  if (!isRecord(value)) return null
  const type = readString(value, 'type')
  if (type === 'agent_start' || type === 'turn_start') return { kind: 'started' }
  if (type === 'message_update') {
    const update = value.assistantMessageEvent
    if (!isRecord(update) || readString(update, 'type') !== 'text_delta') return null
    const text = readString(update, 'delta')
    return text === null ? null : { kind: 'text_delta', text }
  }
  if (type === 'tool_execution_start') {
    const toolCallId = readString(value, 'toolCallId')
    const toolName = readString(value, 'toolName')
    return toolCallId === null || toolName === null
      ? null
      : { kind: 'tool_start', toolCallId, toolName }
  }
  if (type === 'tool_execution_end') {
    const toolCallId = readString(value, 'toolCallId')
    const toolName = readString(value, 'toolName')
    if (toolCallId === null || toolName === null) return null
    const result = value.result
    const content = isRecord(result) ? result.content : null
    const first = Array.isArray(content) ? content[0] : null
    const output = isRecord(first) ? readString(first, 'text') ?? '' : ''
    return {
      kind: 'tool_end',
      toolCallId,
      toolName,
      output,
      isError: value.isError === true,
    }
  }
  if (type === 'approval_requested') {
    const toolCallId = readString(value, 'toolCallId')
    const toolName = readString(value, 'toolName')
    return toolCallId === null || toolName === null
      ? null
      : { kind: 'approval', toolCallId, toolName, args: readArgs(value) }
  }
  if (type === 'question_requested') {
    const questionId = readString(value, 'questionId')
    const question = readString(value, 'question')
    return questionId === null || question === null ? null : { kind: 'question', questionId, question }
  }
  if (type === 'message_end') return { kind: 'message_end', messageId: readString(value, 'messageId') ?? '' }
  if (type === 'turn_end') return { kind: 'turn_end' }
  if (type === 'agent_end') return { kind: 'agent_end' }
  if (type === 'compaction_start') {
    return { kind: 'compaction_start', reason: readString(value, 'reason') ?? 'compaction' }
  }
  if (type === 'compaction_end') {
    const result = isRecord(value.result) ? value.result : {}
    return { kind: 'compaction_end', reason: readString(value, 'reason') ?? 'compaction', summary: readString(result, 'summary') ?? '' }
  }
  if (type === 'queue_update') {
    const steering = Array.isArray(value.steering) ? value.steering.filter((item): item is string => typeof item === 'string') : []
    const followUp = Array.isArray(value.followUp) ? value.followUp.filter((item): item is string => typeof item === 'string') : []
    return { kind: 'queue_update', steering, followUp }
  }
  if (type === 'auto_retry_start') {
    return {
      kind: 'retry_start',
      attempt: readNumber(value, 'attempt'),
      maxAttempts: readNumber(value, 'maxAttempts'),
      delayMs: readNumber(value, 'delayMs'),
    }
  }
  if (type === 'auto_retry_end') {
    return { kind: 'retry_end', success: value.success === true, attempt: readNumber(value, 'attempt') }
  }
  if (type === 'bash_execution_update') {
    const text = readString(value, 'delta')
    return text === null ? null : { kind: 'bash_delta', text }
  }
  if (type === 'error') {
    const message = readString(value, 'message')
    return message === null ? null : { kind: 'error', message }
  }
  // The engine switched sessions on its own, because the agent asked to resume
  // one. The shell has to follow it, or the transcript on screen belongs to a
  // session the engine has left.
  if (type === 'session_switched') {
    const path = readString(value, 'path')
    if (path === null) return null
    const session = isRecord(value.session) ? value.session : null
    return {
      kind: 'session_switched',
      path,
      name: session ? readString(session, 'name') ?? '' : '',
      cwd: session ? readString(session, 'cwd') ?? '' : '',
    }
  }
  if (type === 'agent_settled') return { kind: 'settled', reason: readString(value, 'reason') ?? 'done' }
  return null
}

function parseMessage(
  line: string,
): { kind: 'response'; id: string; success: boolean; data: unknown; error: string | null } | { kind: 'event'; event: AgentEvent } | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const type = readString(value, 'type')
  if (type === 'response') {
    return {
      kind: 'response',
      id: readString(value, 'id') ?? '',
      success: value.success === true,
      data: value.data,
      error: readString(value, 'error'),
    }
  }
  const event = parseEvent(value)
  return event === null ? null : { kind: 'event', event }
}

export function createLocalAgentClient(reply: (prompt: string) => string): AgentClient {
  return {
    mode: 'local',
    async steer() {},
    async followUp() {},
    async bash() { return { output: '', exitCode: 0, truncated: false } },
    async abortBash() {},
    async getDiff() { return 'No uncommitted changes.' },
    async listSkills() { return { skills: [], projects: [] } },
    async setSkillEnabled() { return { pending: false } },
    async getMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async addMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async replaceMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async removeMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async send(prompt, onEvent) {
      onEvent({ kind: 'text_delta', text: reply(prompt) })
      onEvent({ kind: 'settled', reason: 'done' })
    },
    async answerApproval() {},
    async answerQuestion() {},
    async listSessions() { return [] },
    async newSession() { return null },
    async switchSession() { return null },
    async setSessionName() {},
    async getState() { return { state: 'idle', sessionId: 'local', sessionFile: '', cwd: '', model: 'local', provider: 'local', thinkingLevel: 'off', approvalMode: 'auto', autoCompaction: false, autoRetry: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', maxTokens: 0 } },
    async ping() { return true },
    async getProviders() { return [{ id: 'local', name: 'Local preview', configured: true }] },
    async getCommands() { return [] },
    async getSessionStats() { return null },
    async getTranscript() { return [] },
    async getLastAssistantText() { return '' },
    async getForkMessages() { return [] },
    async getTree() { return [] },
    async fork() { return null },
    async undo() { return null },
    async cloneSession() { return null },
    async exportHtml() { return null },
    async compact() { return '' },
    async snapcompact() { return '' },
    async recap() { return '' },
    async getModels() { return ['local'] },
    async getThinkingLevels() { return ['off'] },
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
    stop() {},
    close() {},
  }
}

export class EscapeAgentClient implements AgentClient {
  readonly mode = 'engine' as const
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
  private readonly stdin: Bun.FileSink
  private readonly pending = new Map<string, PendingResponse>()
  private readonly encoder = new TextEncoder()
  private nextId = 0
  private closed = false
  private eventHandler: ((event: AgentEvent) => void) | null = null

  constructor(options: { command: string; cwd: string }) {
    this.process = Bun.spawn([options.command, 'rpc', '--cwd', options.cwd], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    })
    this.stdin = this.process.stdin
    void this.readOutput()
  }

  async steer(prompt: string): Promise<void> {
    await this.request({ type: 'steer', text: prompt })
  }

  async followUp(prompt: string): Promise<void> {
    await this.request({ type: 'follow_up', text: prompt })
  }

  async abortBash(): Promise<void> {
    await this.request({ type: 'abort_bash' })
  }

  async getDiff(paths: string[] = []): Promise<string> {
    const data = await this.request({ type: 'diff', paths })
    return isRecord(data) ? readString(data, 'diff') ?? '' : ''
  }

  async listSkills(): Promise<{ skills: SkillSummary[]; projects: SkillProject[] }> {
    const data = await this.request({ type: 'list_skills' })
    if (!isRecord(data)) return { skills: [], projects: [] }
    const projects = Array.isArray(data.projects)
      ? data.projects.flatMap((value) => {
          if (!isRecord(value)) return []
          const path = readString(value, 'path')
          if (!path) return []
          return [{ path, name: readString(value, 'name') ?? projectName(path) }]
        })
      : []
    if (!Array.isArray(data.skills)) return { skills: [], projects }
    const skills = data.skills.flatMap((value) => {
      if (!isRecord(value)) return []
      const path = readString(value, 'path')
      const name = readString(value, 'name')
      if (!path || !name) return []
      return [{
        name,
        path,
        description: readString(value, 'description') ?? '',
        location: readString(value, 'location') ?? '',
        enabled: value.enabled === true,
        globalEnabled: value.globalEnabled !== false,
        project: readString(value, 'project') ?? '',
        overrides: Array.isArray(value.overrides)
          ? value.overrides.flatMap((o) => {
              if (!isRecord(o)) return []
              const project = readString(o, 'project')
              if (!project) return []
              return [{ project, enabled: o.enabled === true }]
            })
          : [],
      }]
    })
    return { skills, projects }
  }

  async setSkillEnabled(path: string, enabled: boolean | null, scope: SkillScope, project?: string): Promise<{ pending: boolean }> {
    const data = await this.request({ type: 'set_skill_enabled', sessionPath: path, enabled, scope, project })
    return { pending: isRecord(data) && data.pending === true }
  }

  async getMemory(): Promise<MemorySnapshot> {
    return this.memory({ type: 'memory', op: 'list' })
  }

  async addMemory(text: string): Promise<MemorySnapshot> {
    return this.memory({ type: 'memory', op: 'add', text })
  }

  async replaceMemory(index: number, text: string): Promise<MemorySnapshot> {
    return this.memory({ type: 'memory', op: 'replace', index, text })
  }

  async removeMemory(index: number): Promise<MemorySnapshot> {
    return this.memory({ type: 'memory', op: 'remove', index })
  }

  private async memory(payload: Record<string, unknown>): Promise<MemorySnapshot> {
    const data = await this.request(payload)
    const empty: MemorySnapshot = { entries: [], used: 0, max: 2200, path: '' }
    if (!isRecord(data)) return empty
    return {
      entries: Array.isArray(data.entries) ? data.entries.filter((v): v is string => typeof v === 'string') : [],
      used: typeof data.used === 'number' ? data.used : 0,
      max: typeof data.max === 'number' ? data.max : 2200,
      path: readString(data, 'path') ?? '',
    }
  }

  async bash(command: string, onDelta: (text: string) => void): Promise<BashResult> {
    this.eventHandler = (event) => {
      if (event.kind === 'bash_delta') onDelta(event.text)
    }
    const data = await this.request({ type: 'bash', command })
    if (!isRecord(data)) return { output: '', exitCode: 0, truncated: false }
    return {
      output: readString(data, 'output') ?? '',
      exitCode: readNumber(data, 'exitCode'),
      truncated: data.truncated === true,
    }
  }

  async send(prompt: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.eventHandler = onEvent
    await this.request({ type: 'prompt', message: prompt })
  }

  async answerApproval(toolCallId: string, approved: boolean): Promise<void> {
    await this.request({ type: 'answer_approval', toolCallId, approved })
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    await this.request({ type: 'answer_question', questionId, answer })
  }

  async listSessions(): Promise<SessionSummary[]> {
    const data = await this.request({ type: 'list_sessions' })
    if (!isRecord(data) || !Array.isArray(data.sessions)) return []
    return data.sessions.flatMap((value) => {
      if (!isRecord(value)) return []
      const id = readString(value, 'id')
      const path = readString(value, 'path')
      const cwd = readString(value, 'cwd')
      if (!id || !path || !cwd) return []
      return [{
        id,
        path,
        cwd,
        name: readString(value, 'name') ?? '',
        updatedAt: typeof value.mtime === 'number' ? value.mtime : 0,
      }]
    })
  }

  async newSession(): Promise<SessionSummary | null> {
    const data = await this.request({ type: 'new_session' })
    return readSessionSummary(data)
  }

  async switchSession(path: string): Promise<SessionSummary | null> {
    const data = await this.request({ type: 'switch_session', sessionPath: path })
    return readSessionSummary(data)
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: 'set_session_name', name })
  }

  async getState(): Promise<AgentState> {
    const data = await this.request({ type: 'get_state' })
    if (!isRecord(data)) return { state: '', sessionId: '', sessionFile: '', cwd: '', model: '', provider: '', thinkingLevel: '', approvalMode: 'auto', autoCompaction: false, autoRetry: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', maxTokens: 0 }
    return {
      state: readString(data, 'state') ?? '',
      sessionId: readString(data, 'sessionId') ?? '',
      sessionFile: readString(data, 'sessionFile') ?? '',
      cwd: readString(data, 'cwd') ?? '',
      model: readString(data, 'model') ?? '',
      provider: readString(data, 'provider') ?? '',
      thinkingLevel: readString(data, 'thinkingLevel') ?? '',
      approvalMode: readString(data, 'approvalMode') ?? 'auto',
      autoCompaction: data.autoCompaction === true,
      autoRetry: data.autoRetry === true,
      steeringMode: readString(data, 'steeringMode') ?? 'one-at-a-time',
      followUpMode: readString(data, 'followUpMode') ?? 'one-at-a-time',
      maxTokens: readNumber(data, 'maxTokens'),
    }
  }

  async ping(): Promise<boolean> {
    const data = await this.request({ type: 'ping' })
    return isRecord(data) && data.pong === true
  }

  async getProviders(): Promise<ProviderSummary[]> {
    const data = await this.request({ type: 'get_providers' })
    if (!isRecord(data) || !Array.isArray(data.providers)) return []
    return data.providers.flatMap((value) => {
      if (!isRecord(value)) return []
      const id = readString(value, 'id')
      const name = readString(value, 'name')
      if (!id || !name) return []
      return [{ id, name, configured: value.configured === true }]
    })
  }

  async getCommands(): Promise<CommandSummary[]> {
    const data = await this.request({ type: 'get_commands' })
    if (!isRecord(data) || !Array.isArray(data.commands)) return []
    return data.commands.flatMap((value) => {
      if (!isRecord(value)) return []
      const name = readString(value, 'name') ?? readString(value, 'command')
      if (!name) return []
      return [{ name, description: readString(value, 'description') ?? '' }]
    })
  }

  async getSessionStats(): Promise<SessionStats | null> {
    const data = await this.request({ type: 'get_session_stats' })
    if (!isRecord(data)) return null
    const tokens = isRecord(data.tokens) ? data.tokens : {}
    const context = isRecord(data.contextUsage) ? data.contextUsage : {}
    return {
      sessionId: readString(data, 'sessionId') ?? '',
      userMessages: readNumber(data, 'userMessages'),
      assistantMessages: readNumber(data, 'assistantMessages'),
      toolCalls: readNumber(data, 'toolCalls'),
      totalMessages: readNumber(data, 'totalMessages'),
      tokens: {
        input: readNumber(tokens, 'input'),
        output: readNumber(tokens, 'output'),
        cacheRead: readNumber(tokens, 'cacheRead'),
        cacheWrite: readNumber(tokens, 'cacheWrite'),
        total: readNumber(tokens, 'total'),
      },
      cost: readNumber(data, 'cost'),
      contextTokens: readNumberOrNull(context, 'tokens'),
      contextWindow: readNumber(context, 'contextWindow'),
      contextPercent: readNumberOrNull(context, 'percent'),
    }
  }

  async getTranscript(sessionPath?: string): Promise<TranscriptMessage[]> {
    const data = await this.request({ type: 'get_entries', since: '', sessionPath })
    if (!isRecord(data) || !Array.isArray(data.entries)) return []
    return data.entries.flatMap((value) => {
      if (!isRecord(value) || !isRecord(value.message)) return []
      const role = readString(value.message, 'role')
      const blocks = Array.isArray(value.message.content) ? value.message.content : []
      const text = blocks.flatMap((block) => isRecord(block) && readString(block, 'type') === 'text' ? [readString(block, 'text') ?? ''] : []).join('')
      const toolCalls = blocks.flatMap((block) => {
        if (!isRecord(block) || readString(block, 'type') !== 'toolCall') return []
        const name = readString(block, 'name') ?? readString(block, 'id') ?? 'tool'
        return [`[tool] ${name}…`]
      })
      if (role !== 'toolResult' && role !== 'user' && role !== 'assistant') return []
      const content = role === 'toolResult'
        ? `[tool] ${readString(value.message, 'toolName') ?? 'result'}\n${text}`
        : [text, ...toolCalls].filter(Boolean).join('\n')
      if (!content) return []
      const id = readString(value, 'id') ?? `${role}-${content.length}`
      return [{ id, role: role === 'toolResult' ? 'assistant' : role, content }]
    })
  }

  async getLastAssistantText(): Promise<string> {
    const data = await this.request({ type: 'get_last_assistant_text' })
    return isRecord(data) ? readString(data, 'text') ?? '' : ''
  }

  async getForkMessages(): Promise<ForkMessage[]> {
    const data = await this.request({ type: 'get_fork_messages' })
    if (!isRecord(data) || !Array.isArray(data.messages)) return []
    return data.messages.flatMap((value) => {
      if (!isRecord(value)) return []
      const entryId = readString(value, 'entryId')
      return entryId ? [{ entryId, text: readString(value, 'text') ?? '' }] : []
    })
  }

  async getTree(): Promise<SessionTreeNode[]> {
    const data = await this.request({ type: 'get_tree' })
    if (!isRecord(data) || !Array.isArray(data.tree)) return []
    const parseNode = (value: unknown): SessionTreeNode | null => {
      if (!isRecord(value)) return null
      const entry = isRecord(value.Entry) ? value.Entry : isRecord(value.entry) ? value.entry : {}
      const message = isRecord(entry.message) ? entry.message : {}
      const role = readString(message, 'role')
      const content = Array.isArray(message.content)
        ? message.content.flatMap((block) => isRecord(block) && readString(block, 'type') === 'text' ? [readString(block, 'text') ?? ''] : []).join('')
        : ''
      const entryId = readString(entry, 'id')
      if (!entryId) return null
      const children = Array.isArray(value.Children) ? value.Children : Array.isArray(value.children) ? value.children : []
      return {
        entryId,
        role: role === 'user' || role === 'assistant' ? role : 'other',
        text: content,
        children: children.flatMap((child) => { const parsed = parseNode(child); return parsed ? [parsed] : [] }),
      }
    }
    return data.tree.flatMap((node) => { const parsed = parseNode(node); return parsed ? [parsed] : [] })
  }

  async fork(entryId: string): Promise<string | null> {
    const data = await this.request({ type: 'fork', entryId })
    return isRecord(data) ? readString(data, 'path') : null
  }

  async undo(): Promise<string | null> {
    const data = await this.request({ type: 'undo' })
    return isRecord(data) ? readString(data, 'path') : null
  }

  async cloneSession(): Promise<string | null> {
    const data = await this.request({ type: 'clone' })
    return isRecord(data) ? readString(data, 'path') : null
  }

  async exportHtml(outputPath = ''): Promise<ExportResult | null> {
    const data = await this.request({ type: 'export_html', outputPath })
    if (!isRecord(data)) return null
    const path = readString(data, 'path')
    return path ? { path } : null
  }

  async compact(): Promise<string> {
    const data = await this.request({ type: 'compact' })
    return isRecord(data) ? readString(data, 'summary') ?? '' : ''
  }

  async snapcompact(): Promise<string> {
    const data = await this.request({ type: 'snapcompact' })
    return isRecord(data) ? readString(data, 'summary') ?? '' : ''
  }

  async recap(): Promise<string> {
    const data = await this.request({ type: 'recap' })
    return isRecord(data) ? readString(data, 'recap') ?? '' : ''
  }

  async getModels(): Promise<string[]> {
    const data = await this.request({ type: 'get_models' })
    const values = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.models) ? data.models : []
    return values.flatMap((value) => {
      if (typeof value === 'string') return [value]
      if (!isRecord(value)) return []
      const id = readString(value, 'id')
      return id ? [id] : []
    })
  }

  async getThinkingLevels(): Promise<string[]> {
    const data = await this.request({ type: 'get_available_thinking_levels' })
    if (!isRecord(data) || !Array.isArray(data.levels)) return []
    return data.levels.flatMap((value) => typeof value === 'string' ? [value] : [])
  }

  async setModel(model: string): Promise<void> {
    await this.request({ type: 'set_model', model })
  }

  async setProvider(provider: string): Promise<void> {
    await this.request({ type: 'set_provider', provider })
  }

  async setApiKey(provider: 'opencode-go' | 'opencode-zen', apiKey: string): Promise<void> {
    await this.request({ type: 'set_api_key', provider, apiKey })
  }

  async setApprovalMode(mode: 'auto' | 'ask'): Promise<void> {
    await this.request({ type: 'set_approval_mode', mode })
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.request({ type: 'set_auto_compaction', enabled })
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.request({ type: 'set_auto_retry', enabled })
  }

  async abortRetry(): Promise<void> {
    await this.request({ type: 'abort_retry' })
  }

  async setMaxTokens(maxTokens: number): Promise<void> {
    await this.request({ type: 'set_max_tokens', maxTokens })
  }

  async setSteeringMode(mode: string): Promise<void> {
    await this.request({ type: 'set_steering_mode', mode })
  }

  async setFollowUpMode(mode: string): Promise<void> {
    await this.request({ type: 'set_follow_up_mode', mode })
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.request({ type: 'set_thinking_level', level })
  }

  private async request(payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) throw new Error('escape client is closed')
    const id = `gui-${++this.nextId}`
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    await this.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
    return response
  }

  stop(): void {
    if (this.closed) return
    void Promise.resolve(
      this.stdin.write(`${JSON.stringify({ type: 'abort', id: `gui-stop-${++this.nextId}` })}\n`),
    ).catch(() => {})
  }

  private async readOutput(): Promise<void> {
    const reader = this.process.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) this.handleLine(line)
      }
      this.rejectPending(new Error('escape rpc process closed'))
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private handleLine(line: string): void {
    const message = parseMessage(line.trim())
    if (message === null) return
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.success) pending.resolve(message.data)
      else pending.reject(new Error(message.error ?? 'escape rpc request failed'))
      return
    }
    this.eventHandler?.(message.event)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stdin.end()
    this.process.kill()
    this.rejectPending(new Error('escape client closed'))
  }
}

function resolveEngineCommand(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.ESCAPE_BIN) return process.env.ESCAPE_BIN

  const candidates: string[] = []
  if (typeof Bun !== 'undefined') {
    const mainDir = dirname(Bun.main)
    candidates.push(
      // flat release: escape next to the script/binary
      join(mainDir, 'escape'),
      // app bundle: Resources/app/shell.js -> Resources/bin/escape
      join(mainDir, '..', 'bin', 'escape'),
      // compiled binary in a macOS .app
      join(mainDir, '..', 'Resources', 'bin', 'escape'),
      join(mainDir, 'resources', 'bin', 'escape'),
      join(mainDir, '..', 'resources', 'bin', 'escape'),
    )
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'escape'
}

export function createEscapeAgentClient(options: { command?: string; cwd?: string } = {}): AgentClient {
  return new EscapeAgentClient({
    command: resolveEngineCommand(options.command),
    cwd: options.cwd ?? process.cwd(),
  })
}
