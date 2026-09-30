import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** How a turn finished. `interrupted` is the user cutting it short, not a failure. */
export type TurnState = 'completed' | 'interrupted' | 'error'

export type AgentEvent =
  | { kind: 'started' }
  /**
   * The engine opened a turn and named it. This is the authoritative turn
   * boundary: grouping messages guesses at one, and guesses wrong the moment a
   * provider emits commentary between tool calls. An older engine sends no
   * `turnId`, which is why it is optional.
   */
  | { kind: 'turn_start'; turnId?: string }
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
  | { kind: 'message_end'; messageId: string; attachments?: TranscriptAttachment[] }
  | { kind: 'turn_end'; turnId?: string; reason: string; state: TurnState }
  /**
   * A Design Mode phase finished. The composer renders these as a phase list
   * rather than as prose, which is why they are events and not messages: they
   * are the run reporting on itself, and a run is several minutes long.
   */
  | { kind: 'design_progress'; phase: string; pass: number; detail: string }
  | {
      kind: 'design_done'
      passed: boolean
      repairs: number
      verdict: string
      why: string
      shots: { viewport: string; path: string }[]
      error: string
    }
  | { kind: 'agent_end' }
  | { kind: 'settled'; reason: string }

/** One selectable model. `provider` disambiguates the same id across sources. */
export interface ModelInfo {
  id: string
  name?: string
  provider?: string
}

function modelInfo(id: string, name?: string, provider?: string): ModelInfo {
  return { id, name: name || titleCaseModelId(id), provider }
}

/** Fallback display name for an engine that sends no `name`. */
function titleCaseModelId(id: string): string {
  return id.split('-').map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part)).join(' ')
}

export interface AgentClient {
  readonly mode: 'engine' | 'local'
  send(prompt: string, attachments: string[], onEvent: (event: AgentEvent) => void): Promise<void>
  /**
   * Starts a Design Mode run. Resolves as soon as the run is under way; the
   * phases arrive as `design_progress` events and the outcome as `design_done`,
   * because a run is minutes long and a request/response pair cannot hold a
   * response open that long without teaching the caller to wait for nothing.
   */
  startDesign(request: string, onEvent?: (event: AgentEvent) => void): Promise<void>
  /** Stops a run and waits for its preview server to be down. */
  cancelDesign(): Promise<void>
  steer(prompt: string): Promise<void>
  followUp(prompt: string): Promise<void>
  bash(command: string, onDelta: (text: string) => void): Promise<BashResult>
  abortBash(): Promise<void>
  getDiff(paths?: string[]): Promise<string>
  // Source control. The engine owns every git mutation so a write to the
  // repository cannot arrive on a path that skipped its approval gate.
  /** Copies text to the system clipboard. No GPUIX or DOM API exists for it. */
  copyToClipboard(text: string): Promise<void>
  vcsStatus(): Promise<VcsStatus>
  /** One file's patch. Independent of the capped whole-tree diff. */
  vcsFileDiff(path: string): Promise<string>
  vcsStage(paths?: string[]): Promise<void>
  vcsUnstage(paths?: string[]): Promise<void>
  vcsCommit(message: string, paths?: string[]): Promise<void>
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
  listProjects(): Promise<{ projects: Project[]; current: string }>
  completePath(path: string): Promise<PathCompletion[]>
  searchDirs(query: string, root?: string, depth?: number, limit?: number): Promise<{ directories: PathCompletion[]; root: string }>
  addProject(path: string): Promise<{ project: Project; added: boolean }>
  removeProject(path: string): Promise<{ removed: boolean }>
  switchProject(path: string): Promise<{ cwd: string }>
  getDiagnostics(): Promise<Diagnostics | null>
  writeDiagnostics(outputPath?: string): Promise<{ path: string; report: string } | null>
  getTranscript(sessionPath?: string): Promise<TranscriptMessage[]>
  getTranscriptPage(beforeId: string, limit: number, sessionPath?: string): Promise<{ messages: TranscriptMessage[]; hasMore: boolean; earliestId: string }>
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
  getModels(): Promise<ModelInfo[]>
  getThinkingLevels(): Promise<string[]>
  setModel(model: string): Promise<void>
  setProvider(provider: string): Promise<void>
  setApiKey(provider: 'opencode-go' | 'opencode-zen', apiKey: string): Promise<void>
  removeApiKey(provider: 'opencode-go' | 'opencode-zen' | 'api'): Promise<void>
  setApiEndpoint(baseURL: string, apiKey: string): Promise<void>
  setTitleModel(model: string): Promise<void>
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

/** One path in the working tree, as `git status --porcelain` reports it. */
export type VcsFileStatus = {
  path: string
  insertions: number
  deletions: number
  untracked: boolean
}

/**
 * The working tree. A path can appear in both `staged` and `unstaged` — that
 * is what a file staged and then edited again looks like — so the two lists
 * are not a partition of the tree.
 */
export type VcsStatus = {
  isRepo: boolean
  refName: string
  hasChanges: boolean
  staged: VcsFileStatus[]
  unstaged: VcsFileStatus[]
  insertions: number
  deletions: number
}

/** A file the user dropped on the composer, as the session recorded it. */
export type TranscriptAttachment = {
  /** The block type it was stored as: "image" for images, "media" for the rest. */
  kind: 'image' | 'media'
  mimeType: string
  /** base64 payload, handed to `img.src` as a data URL. */
  data: string
  /** Where it was dropped from, when the session kept it. */
  source?: string
}

/**
 * One readable line of a tool call's arguments.
 *
 * The collapsed transcript row shows what was called and roughly with what.
 * A `bash` command is the argument a reader actually wants, so it wins over a
 * JSON dump; everything else is a short JSON form, clipped so one long
 * argument cannot take over the row.
 */
function compactToolArgs(block: JsonRecord): string | undefined {
  const args = block.arguments ?? block.input ?? block.args
  if (!isRecord(args)) {
    return typeof args === 'string' && args.trim() !== '' ? clip(args.trim(), 120) : undefined
  }
  const command = readString(args, 'command') ?? readString(args, 'cmd')
  if (command && command.trim() !== '') return clip(command.trim().replace(/\s+/g, ' '), 120)
  const path = readString(args, 'path') ?? readString(args, 'file_path')
  if (path && path.trim() !== '') return clip(path.trim(), 120)
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${key}: ${clip(value.trim(), 40)}`)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}: ${value}`)
    if (parts.length === 3) break
  }
  return parts.length > 0 ? clip(parts.join(' · '), 120) : undefined
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export type TranscriptMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Carried separately from `content`, which is text only by design: a message
   *  can be a picture with nothing typed, and dropping the blocks here would
   *  lose it. */
  attachments?: TranscriptAttachment[]
  /**
   * Tool calls and their results, kept out of `content`.
   *
   * They used to be flattened into the message text as `[tool] bash…`, which
   * made the transcript render a tool log as if the model had typed it — the
   * markdown renderer then styled it as prose. Tool activity is structure, not
   * words, so it rides beside the text and the transcript folds it into a row.
   */
  tools?: TranscriptTool[]
}

export type TranscriptTool = {
  name: string
  /** First line of the call arguments, for the collapsed row. */
  args?: string
  status: 'running' | 'done' | 'error'
  /** Result text. Empty while the call is still in flight. */
  output?: string
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

type EngineProcess = { kill: () => void; exitCode: number | null }

/**
 * The engine subprocess this app process owns, if any.
 *
 * On globalThis, not at module scope, because the thing it has to outlive is a
 * module reload. `bun --hot` re-evaluates this file, so a module-level binding
 * comes back as null and the previous engine is lost exactly when it is most
 * needed — which is why holding it here is the whole fix rather than an
 * optimisation.
 */
const engineRegistry = globalThis as typeof globalThis & { __escapeEngine?: EngineProcess }

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

// TurnTiming is what one model round trip cost, split by phase. Read and build
// grow with the session; firstToken is the network and the model. Separating
// them is the only way to tell which one to go and fix.
export type TurnTiming = {
  at?: string
  iterations?: number
  historyReadMs?: number
  buildMs?: number
  firstTokenMs?: number
  totalMs?: number
  compacted?: boolean
  error?: string
}

export type Diagnostics = {
  version?: string
  provider?: string
  model?: string
  thinkingLevel?: string
  sessionId?: string
  sessionPath?: string
  sessionSizeBytes?: number
  sessionEntries?: number
  uptimeMs?: number
  skills?: number
  tools?: number
  contextWindow?: number
  lastError?: string
  firstTokenP50Ms?: number
  firstTokenP95Ms?: number
  turns?: TurnTiming[]
  /** Only present on writeDiagnostics: the rendered report. */
  report?: string
  path?: string
}

/** How much of a transcript to load before someone scrolls back for more. */
export const TRANSCRIPT_PAGE = 200

export type Project = { path: string; added?: string }

export type PathCompletion = {
  name: string
  path: string
  dir: boolean
  hasChildren: boolean
  /**
   * Indices in the path relative to the search root that the query matched, as
   * computed by the engine's own matcher. Present so the highlight and the
   * ranking come from one implementation; nil when nothing was typed.
   */
  match?: number[]
  /** Unix nanos the directory last changed, used to show recency. */
  mtime?: number
}

export type AgentState = {
  state: string
  sessionId: string
  sessionFile: string
  cwd: string
  model: string
  provider: string
  thinkingLevel: string
  titleModel: string
  apiEndpointBaseURL: string
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

/** Reads one of the status buckets. A missing or malformed list reads as empty. */
function readFileList(record: JsonRecord, key: string): VcsFileStatus[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  const out: VcsFileStatus[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const path = readString(entry, 'path')
    if (!path) continue
    out.push({
      path,
      insertions: readNumber(entry, 'insertions'),
      deletions: readNumber(entry, 'deletions'),
      untracked: entry.untracked === true,
    })
  }
  return out
}

/** The shape returned when the engine is unreachable, so the UI has something honest to show. */
const EMPTY_VCS_STATUS: VcsStatus = {
  isRepo: false,
  refName: '',
  hasChanges: false,
  staged: [],
  unstaged: [],
  insertions: 0,
  deletions: 0,
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
  if (type === 'agent_start') return { kind: 'started' }
  if (type === 'turn_start') {
    const turnId = readString(value, 'turnId')
    return { kind: 'turn_start', ...(turnId ? { turnId } : {}) }
  }
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
  if (type === 'message_end') {
    // The engine hands back the bytes of whatever the message was sent with, so
    // the picture is on screen as soon as it is sent rather than only after the
    // transcript is reloaded.
    const attachments = Array.isArray(value.attachments)
      ? value.attachments.flatMap((item): TranscriptAttachment[] => {
          if (!isRecord(item)) return []
          const kind = readString(item, 'kind')
          const data = readString(item, 'data')
          if ((kind !== 'image' && kind !== 'media') || !data) return []
          return [{
            kind,
            mimeType: readString(item, 'mimeType') ?? '',
            data,
            source: readString(item, 'source') ?? undefined,
          }]
        })
      : []
    return {
      kind: 'message_end',
      messageId: readString(value, 'messageId') ?? '',
      attachments,
    }
  }
  if (type === 'turn_end') {
    const turnId = readString(value, 'turnId')
    const state = readString(value, 'state')
    return {
      kind: 'turn_end',
      ...(turnId ? { turnId } : {}),
      reason: readString(value, 'reason') ?? 'done',
      // An engine that predates explicit states sends only a reason. `stopped`
      // is the one reason that is unambiguously an interruption.
      state: state === 'interrupted' || state === 'error' || state === 'completed'
        ? state
        : readString(value, 'reason') === 'stopped' ? 'interrupted' : 'completed',
    }
  }
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
  if (type === 'design_progress') {
    return {
      kind: 'design_progress',
      phase: readString(value, 'phase') ?? '',
      pass: typeof value.pass === 'number' ? value.pass : 0,
      detail: readString(value, 'detail') ?? '',
    }
  }
  if (type === 'design_done') {
    const shots = Array.isArray(value.shots)
      ? value.shots.flatMap((entry) => {
          if (!isRecord(entry)) return []
          const path = readString(entry, 'path')
          if (!path) return []
          return [{ viewport: readString(entry, 'viewport') ?? '', path }]
        })
      : []
    return {
      kind: 'design_done',
      passed: value.passed === true,
      repairs: typeof value.repairs === 'number' ? value.repairs : 0,
      verdict: readString(value, 'verdict') ?? '',
      why: readString(value, 'why') ?? '',
      shots,
      error: readString(value, 'error') ?? '',
    }
  }
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
    async startDesign() { throw new Error('design is not available in the fake engine') },
    async cancelDesign() {},
    async copyToClipboard() {},
    async vcsStatus() { return EMPTY_VCS_STATUS },
    async vcsFileDiff() { return '' },
    async vcsStage() {},
    async vcsUnstage() {},
    async vcsCommit() {},
    async listSkills() { return { skills: [], projects: [] } },
    async setSkillEnabled() { return { pending: false } },
    async getMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async addMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async replaceMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async removeMemory() { return { entries: [], used: 0, max: 2200, path: '' } },
    async send(prompt, _attachments, onEvent) {
      onEvent({ kind: 'text_delta', text: reply(prompt) })
      onEvent({ kind: 'settled', reason: 'done' })
    },
    async answerApproval() {},
    async answerQuestion() {},
    async listSessions() { return [] },
    async newSession() { return null },
    async switchSession() { return null },
    async setSessionName() {},
    async getState() { return { state: 'idle', sessionId: 'local', sessionFile: '', cwd: '', model: 'local', provider: 'local', thinkingLevel: 'off', titleModel: '', apiEndpointBaseURL: '', approvalMode: 'auto', autoCompaction: false, autoRetry: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', maxTokens: 0 } },
    async ping() { return true },
    async getProviders() { return [{ id: 'local', name: 'Local preview', configured: true }] },
    async getCommands() { return [] },
    async getSessionStats() { return null },
    async listProjects() { return { projects: [], current: '' } },
    async completePath() { return [] },
    async searchDirs() { return { directories: [], root: '' } },
    async addProject() { return { project: { path: '' }, added: true } },
    async removeProject() { return { removed: true } },
    async switchProject() { return { cwd: '' } },
    async getDiagnostics() { return null },
    async writeDiagnostics() { return null },
    async getTranscript() { return [] },
    async getTranscriptPage() { return { messages: [], hasMore: false, earliestId: '' } },
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
    async getModels() { return [{ id: 'local' }] },
    async getThinkingLevels() { return ['off'] },
    async setModel() {},
    async setProvider() {},
    async setApiKey() {},
    async removeApiKey() {},
    async setApiEndpoint() {},
    async setTitleModel() {},
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
    // One engine per app process, ever. A hot reload remounts the React tree
    // without running the effect cleanup that would have closed the previous
    // client, so relying on close() alone leaks one engine per reload — and a
    // leaked engine keeps its session store open and its preview port. Retiring
    // the previous one here is what keeps the dev loop at a single instance.
    const previous = engineRegistry.__escapeEngine
    if (previous && previous.exitCode === null) {
      try {
        previous.kill()
      } catch {
        // Already gone, or already on its way out. Either way there is nothing
        // left to do and failing here would cost the caller its new engine.
      }
    }
    this.process = Bun.spawn([options.command, 'rpc', '--cwd', options.cwd], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      env: process.env,
    })
    engineRegistry.__escapeEngine = this.process
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

  async startDesign(request: string, onEvent?: (event: AgentEvent) => void): Promise<void> {
    // A design run is not a turn, so there is no onEvent in the request path.
    // The handler is installed here so the phase events have somewhere to go
    // for the minutes the run lasts.
    if (onEvent) this.eventHandler = onEvent
    const data = await this.request({ type: 'design_start', designRequest: request })
    if (isRecord(data) && data.success === false) {
      throw new Error(readString(data, 'error') ?? 'design could not start')
    }
  }

  async cancelDesign(): Promise<void> {
    await this.request({ type: 'design_cancel' })
  }

  async getDiff(paths: string[] = []): Promise<string> {
    const data = await this.request({ type: 'diff', paths })
    return isRecord(data) ? readString(data, 'diff') ?? '' : ''
  }

  async vcsStatus(): Promise<VcsStatus> {
    const data = await this.request({ type: 'vcs_status' })
    if (!isRecord(data)) return EMPTY_VCS_STATUS
    return {
      isRepo: data.isRepo === true,
      refName: readString(data, 'refName') ?? '',
      hasChanges: data.hasChanges === true,
      staged: readFileList(data, 'staged'),
      unstaged: readFileList(data, 'unstaged'),
      insertions: readNumber(data, 'insertions'),
      deletions: readNumber(data, 'deletions'),
    }
  }

  async copyToClipboard(text: string): Promise<void> {
    await this.request({ type: 'copy_to_clipboard', message: text })
  }

  async vcsFileDiff(path: string): Promise<string> {
    const data = await this.request({ type: 'vcs_file_diff', filePath: path })
    return isRecord(data) ? readString(data, 'diff') ?? '' : ''
  }

  async vcsStage(paths: string[] = []): Promise<void> {
    await this.request({ type: 'vcs_stage', paths })
  }

  async vcsUnstage(paths: string[] = []): Promise<void> {
    await this.request({ type: 'vcs_unstage', paths })
  }

  async vcsCommit(message: string, paths: string[] = []): Promise<void> {
    await this.request({ type: 'vcs_commit', message, paths })
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

  async send(prompt: string, attachments: string[], onEvent: (event: AgentEvent) => void): Promise<void> {
    this.eventHandler = onEvent
    // Paths, not bytes. The engine applies the size limit next to the context
    // window sizes that limit exists to protect, and reads the file so a missing
    // or unreadable one is reported as a refusal rather than a failed request.
    await this.request({ type: 'prompt', message: prompt, attachments })
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
    if (!isRecord(data)) return { state: '', sessionId: '', sessionFile: '', cwd: '', model: '', provider: '', thinkingLevel: '', titleModel: '', apiEndpointBaseURL: '', approvalMode: 'auto', autoCompaction: false, autoRetry: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time', maxTokens: 0 }
    return {
      state: readString(data, 'state') ?? '',
      sessionId: readString(data, 'sessionId') ?? '',
      sessionFile: readString(data, 'sessionFile') ?? '',
      cwd: readString(data, 'cwd') ?? '',
      model: readString(data, 'model') ?? '',
      provider: readString(data, 'provider') ?? '',
      thinkingLevel: readString(data, 'thinkingLevel') ?? '',
      apiEndpointBaseURL: readString(data, 'apiEndpointBaseURL') ?? '',
      titleModel: readString(data, 'titleModel') ?? '',
      approvalMode: readString(data, 'approvalMode') ?? 'auto',
      autoCompaction: data.autoCompaction === true,
      autoRetry: data.autoRetry === true,
      steeringMode: readString(data, 'steeringMode') ?? 'one-at-a-time',
      followUpMode: readString(data, 'followUpMode') ?? 'one-at-a-time',
      maxTokens: readNumber(data, 'maxTokens'),
    }
  }

  async completePath(path: string): Promise<PathCompletion[]> {
    const data = await this.request({ type: 'complete_path', sessionPath: path })
    const list = isRecord(data) && Array.isArray(data.completions) ? data.completions : []
    return list.flatMap((value) => {
      if (!isRecord(value)) return []
      const full = readString(value, 'path')
      const name = readString(value, 'name')
      if (!full || !name) return []
      return [{
        name,
        path: full,
        dir: value.dir === true,
        hasChildren: value.hasChildren === true,
      }]
    })
  }

  // searchDirs is a bounded directory walk ranked against what was typed, which
  // is the same thing a shell function piping find into fzf does. The engine
  // returns the root it searched so the caller can show it.
  async searchDirs(
    query: string,
    root?: string,
    depth = 3,
    limit = 60,
  ): Promise<{ directories: PathCompletion[]; root: string }> {
    const data = await this.request({ type: 'search_dirs', query, sessionPath: root ?? '', depth, limit })
    const list = isRecord(data) && Array.isArray(data.directories) ? data.directories : []
    const directories = list.flatMap((value) => {
      if (!isRecord(value)) return []
      const full = readString(value, 'path')
      const name = readString(value, 'name')
      if (!full || !name) return []
      return [{
        name,
        path: full,
        dir: value.dir === true,
        hasChildren: value.hasChildren === true,
      }]
    })
    return { directories, root: isRecord(data) ? readString(data, 'root') ?? '' : '' }
  }

  async listProjects(): Promise<{ projects: Project[]; current: string }> {
    const data = await this.request({ type: 'list_projects' })
    const list = isRecord(data) && Array.isArray(data.projects) ? data.projects : []
    return {
      projects: list.flatMap((value) => {
        const path = isRecord(value) ? readString(value, 'path') : null
        return path ? [{ path }] : []
      }),
      current: isRecord(data) ? readString(data, 'current') ?? '' : '',
    }
  }

  async addProject(path: string): Promise<{ project: Project; added: boolean }> {
    const data = await this.request({ type: 'add_project', sessionPath: path })
    const project = isRecord(data) && isRecord(data.project) ? { path: readString(data.project, 'path') ?? path } : { path }
    return { project, added: data !== null && isRecord(data) && data.added !== false }
  }

  async removeProject(path: string): Promise<{ removed: boolean }> {
    const data = await this.request({ type: 'remove_project', sessionPath: path })
    return { removed: isRecord(data) && data.removed === true }
  }

  // switchProject moves the engine to another directory, which rebinds its
  // session, tools and settings. It is refused while a turn is running, so
  // callers should surface the error rather than retrying.
  async switchProject(path: string): Promise<{ cwd: string }> {
    const data = await this.request({ type: 'switch_project', sessionPath: path })
    return { cwd: isRecord(data) ? readString(data, 'cwd') ?? path : path }
  }

  async getDiagnostics(): Promise<Diagnostics | null> {
    const data = await this.request({ type: 'get_diagnostics' })
    return (data ?? null) as Diagnostics | null
  }

  // The engine writes the file, not the renderer: it already owns session
  // export, and a diagnostics report is the same kind of artefact.
  async writeDiagnostics(outputPath = ''): Promise<{ path: string; report: string } | null> {
    const data = await this.request({ type: 'write_diagnostics', outputPath })
    return (data ?? null) as { path: string; report: string } | null
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
    return (await this.getTranscriptPage('', TRANSCRIPT_PAGE, sessionPath)).messages
  }

  /**
   * A page of the transcript, oldest-first, with the cursor for reading further
   * back. Opening a long session used to read and render every entry; now it
   * reads a page and scrolls for the rest.
   */
  async getTranscriptPage(
    beforeId: string,
    limit: number,
    sessionPath?: string,
  ): Promise<{ messages: TranscriptMessage[]; hasMore: boolean; earliestId: string }> {
    const data = await this.request({ type: 'get_page', since: beforeId, limit, sessionPath })
    return parseTranscriptPage(data)
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

  async getModels(): Promise<ModelInfo[]> {
    const data = await this.request({ type: 'get_models' })
    const values = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.models) ? data.models : []
    // A model is a per-provider choice, so the same id under two providers is
    // two entries, not a duplicate. The picker shows the provider instead of
    // dropping one, which is why provider and name survive this boundary.
    return values.flatMap((value) => {
      if (typeof value === 'string') return [modelInfo(value)]
      if (!isRecord(value)) return []
      const id = readString(value, 'id')
      return id ? [modelInfo(id, readString(value, 'name') ?? undefined, readString(value, 'provider') ?? undefined)] : []
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

  async removeApiKey(provider: 'opencode-go' | 'opencode-zen'): Promise<void> {
    await this.request({ type: 'remove_api_key', provider })
  }

  async setApiEndpoint(baseURL: string, apiKey: string): Promise<void> {
    await this.request({ type: 'set_api_endpoint', baseURL, apiKey })
  }

  async setTitleModel(model: string): Promise<void> {
    await this.request({ type: 'set_title_model', model })
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
    if (engineRegistry.__escapeEngine === this.process) engineRegistry.__escapeEngine = undefined
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

/**
 * The directory the engine starts in.
 *
 * macOS hands a Finder-launched app the filesystem root as its working
 * directory, so `process.cwd()` is "/" for exactly the runs that matter most:
 * the installed app. The engine would then adopt the root as the project, and
 * the session list would be scoped to a directory nobody chose.
 *
 * ESCAPE_CWD is the explicit override, and $HOME is the fallback because it is
 * the one directory a person is always willing to be working in. A cwd given by
 * a caller, and the terminal's own directory, are both left alone.
 */
export function resolveEngineCwd(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit
  const fromEnv = process.env.ESCAPE_CWD
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  const current = process.cwd()
  if (current === '/' || current === '') return homedir()
  return current
}

export function createEscapeAgentClient(options: { command?: string; cwd?: string } = {}): AgentClient {
  return new EscapeAgentClient({
    command: resolveEngineCommand(options.command),
    cwd: resolveEngineCwd(options.cwd),
  })
}

/**
 * Parses one `get_page` response into transcript messages.
 *
 * Extracted from the client so it can be tested directly. When this lived
 * inside the client, a reference to the accumulator from inside the pass that
 * built it — a temporal dead zone — shipped untested and threw
 * "Cannot access 'messages' before initialization" on every session load.
 */
export function parseTranscriptPage(data: unknown): {
  messages: TranscriptMessage[]
  hasMore: boolean
  earliestId: string
} {
  if (!isRecord(data) || !Array.isArray(data.entries)) {
    return { messages: [], hasMore: false, earliestId: '' }
  }
  // Parsed in two passes. A result has to be filed under the call it
  // answers, and doing that lookup inside this map meant reading `messages`
  // while it was still being assigned — a temporal dead zone error that
  // threw "Cannot access 'messages' before initialization" on every
  // transcript load.
  const parsed = data.entries.flatMap((value): TranscriptMessage[] => {
    if (!isRecord(value) || !isRecord(value.message)) return []
    const role = readString(value.message, 'role')
    if (role !== 'toolResult' && role !== 'user' && role !== 'assistant') return []
    const blocks = Array.isArray(value.message.content) ? value.message.content : []
    const text = blocks
      .flatMap((block) => (isRecord(block) && readString(block, 'type') === 'text' ? [readString(block, 'text') ?? ''] : []))
      .join('')
    // A toolResult's text IS the tool's output, not the assistant's prose.
    // It used to be spliced into `content` as "[tool] bash\n<output>", which
    // made a reloaded turn render a tool log in the assistant's voice, with
    // the markdown renderer styling it as prose. Tool activity is structure,
    // so it rides beside the text and the transcript folds it into a row.
    const isResult = role === 'toolResult'
    const toolName = readString(value.message, 'toolName') ?? 'tool'
    // A result is filed under the call it answers, so a reloaded turn pairs
    // the same way the live turn did.
    const toolKey =
      readString(value.message, 'toolCallId') ?? readString(value, 'id') ?? toolName
    const tools: TranscriptTool[] = isResult
      ? [{
          name: toolName,
          status: readString(value.message, 'isError') === 'true' ? 'error' : 'done',
          output: text,
        }]
      : blocks.flatMap((block): TranscriptTool[] => {
          if (!isRecord(block) || readString(block, 'type') !== 'toolCall') return []
          return [{
            name: readString(block, 'name') ?? readString(block, 'id') ?? 'tool',
            args: compactToolArgs(block),
            status: 'done',
          }]
        })
    // Attachment blocks ride alongside the text rather than inside it. The
    // text join below is the only thing that used to read the content, so
    // before this a message sent with a screenshot came back as its caption
    // alone, and a message that was *only* a screenshot came back as nothing
    // at all.
    const attachments = blocks.flatMap((block): TranscriptAttachment[] => {
      if (!isRecord(block)) return []
      const type = readString(block, 'type')
      if (type !== 'image' && type !== 'media') return []
      const data = readString(block, 'data')
      if (!data) return []
      return [{
        kind: type,
        mimeType: readString(block, 'mimeType') ?? '',
        data,
        source: readString(block, 'source') ?? undefined,
      }]
    })
    // A result contributes no prose: its text is the tool's output, carried
    // on the tool itself.
    const content = isResult ? '' : text
    // A message that is only a picture has no text and is still a message.
    if (!content && attachments.length === 0 && tools.length === 0) return []
    const id = readString(value, 'id') ?? `${role}-${content.length}-${attachments.length}`
    // A result carries the key of the call it answers so the fold below can
    // find the host. The key is not part of the message shape.
    return [{
      id: isResult ? toolKey : id,
      role: isResult ? 'assistant' : role,
      content,
      attachments,
      tools: tools.length > 0 ? tools : undefined,
      _toolKey: isResult ? toolKey : undefined,
    } as TranscriptMessage]
  })

  // Second pass: fold each result into the message that issued the call, so
  // one turn stays one row rather than a call row plus a result row.
  const messages: TranscriptMessage[] = []
  for (const entry of parsed) {
    const key = (entry as { _toolKey?: string })._toolKey
    if (key !== undefined) {
      const host = messages.find((m) => m.id === key)
      if (host) {
        host.tools = [...(host.tools ?? []), ...(entry.tools ?? [])]
        continue
      }
    }
    const { _toolKey: _dropped, ...rest } = entry as { _toolKey?: string } & TranscriptMessage
    messages.push(rest)
  }
  return {
    messages,
    hasMore: data.hasMore === true,
    earliestId: readString(data, 'earliestId') ?? '',
  }
}
