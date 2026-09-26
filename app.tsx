/**
 * A small local AI agent chat rendered with GPUIX.
 *
 * The sample keeps conversations in memory and uses a deterministic local
 * reply function. That makes the app runnable without credentials or a
 * backend while leaving the message boundary easy to replace with a provider
 * call later.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { motion, render } from '@gpuix/react'

import { createEscapeAgentClient, createLocalAgentClient, TRANSCRIPT_PAGE } from './agent-client'
import { matchCommand, SHORTCUTS } from './shortcuts'
import type { KeyEventLike, WindowCommand } from './shortcuts'
import type { AgentClient, CommandSummary, Diagnostics, MemorySnapshot, ProviderSummary, SessionStats, SessionSummary, SessionTreeNode, SkillProject, SkillScope, SkillSummary } from './agent-client'

import iconActivity from './assets/icons/activity.svg' with { type: 'text' }
import iconArrowLeft from './assets/icons/arrow-left.svg' with { type: 'text' }
import iconArrowUp from './assets/icons/arrow-up.svg' with { type: 'text' }
import iconCpu from './assets/icons/cpu.svg' with { type: 'text' }
import iconInbox from './assets/icons/inbox.svg' with { type: 'text' }
import iconMessage from './assets/icons/message.svg' with { type: 'text' }
import iconPanelLeft from './assets/icons/panel-left.svg' with { type: 'text' }
import iconPlus from './assets/icons/plus.svg' with { type: 'text' }
import iconSettings from './assets/icons/settings.svg' with { type: 'text' }
import iconShield from './assets/icons/shield.svg' with { type: 'text' }
import iconSparkle from './assets/icons/sparkle.svg' with { type: 'text' }
import iconTerminal from './assets/icons/terminal.svg' with { type: 'text' }
import iconUser from './assets/icons/user.svg' with { type: 'text' }

// Design tokens — see DESIGN_SYSTEM.md.
// Surfaces climb by lightness and carry elevation; accent is the only chroma and
// is semantic (interactive / active) only. Monospace is for code and IDs only.
const C = {
  canvas: '#0B0D0F',
  sidebar: '#121417',
  surface: '#121417',
  surfaceAlt: '#181B1F',
  raised: '#202429',
  raisedStrong: '#272C32',
  border: '#22262B',
  borderStrong: '#2E333A',
  text: '#E9EBEE',
  secondary: '#9AA0A8',
  tertiary: '#6C727A',
  ghost: '#4B5158',
  accent: '#6C8EF5',
  accentHover: '#7E9CF7',
  accentPressed: '#5A7BE0',
  accentSoft: '#6C8EF514',
  accentWash: '#6C8EF50F',
  purple: '#8B7FE8',
  purpleSoft: '#8B7FE814',
  success: '#3DD68C',
  warning: '#E5A54B',
  error: '#FF6B6B',
  onAccent: '#FFFFFF',
}

// Elevation shadows — shadow and surface always travel together.
const ELEV = {
  overlay: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: -8, color: '#00000099' },
}

const UI_FONT =
  'system-ui, -apple-system, "IBM Plex Sans", Helvetica, sans-serif'
const MONO_FONT = 'ui-monospace, "SF Mono", Menlo, monospace'
const FONT = typeof window === 'undefined' ? UI_FONT : UI_FONT
// The window key handler installed in render() lives outside React, so ChatApp
// publishes its dispatcher here and clears it on unmount.
const windowKeys: { current: ((command: WindowCommand) => void) | null } = { current: null }

/**
 * The single entry point for a resolved window command. Exported so the
 * behaviour behind a shortcut is testable without a native window: tests drive
 * this, render()'s onKeyDown drives this, and nothing else can.
 */
export function dispatchWindowCommand(command: WindowCommand): void {
  windowKeys.current?.(command)
}

const SIDEBAR_WIDTH = 256
// t3code layout constraints: 13*16 min, 16*16 default, main content never
// narrower than 40*16.
const SIDEBAR_MIN_WIDTH = 13 * 16
const SIDEBAR_MAX_WIDTH = 30 * 16
const SIDEBAR_WIDTH_STORAGE_KEY = 'escape_sidebar_width'
const SETTLED_SHELF_KEY = 'escape_settled_shelf'
const SKILL_SCOPE_GLOBAL = '__everywhere__'
// A session untouched for longer than this settles into the shelf. Three days
// matches the reference app's default, and it is the shape of work this app is
// for: pick something up the next day, lose interest after a long weekend.
const SETTLE_AFTER_DAYS = 3
const SETTLE_AFTER_MS = SETTLE_AFTER_DAYS * 24 * 60 * 60 * 1000

/**
 * Whether a session is recent enough to sit in the main list.
 *
 * Modelled as a named pair rather than a boolean so the sidebar row and the
 * shelf count cannot disagree about the same session. Settling is derived from
 * mtime, so working on a session wakes it with no stored state to keep in sync.
 */
type SessionVisibility = 'active' | 'settled'

function visibilityOf(session: SessionSummary, now: number): SessionVisibility {
  if (session.updatedAt > 0 && now - session.updatedAt > SETTLE_AFTER_MS) return 'settled'
  return 'active'
}
// Rubber-banding reference dimension, in the spirit of Apple's sample code:
// the further past a bound the pointer travels, the less the sidebar follows.
const RUBBERBAND_DIMENSION = 400
const RUBBERBAND_CONSTANT = 0.55
const PROJECTION_DECELERATION = 0.998
// Product UI transitions sit in the 150-250ms band. Springs are unavailable on
// GPUIX today, so the collapse and release-settle tweens are the compromise.
const SIDEBAR_TRANSITION_SECONDS = 0.2
// Below this release speed the gesture is treated as placing a size, not
// flinging: a deliberate drag rests exactly where it was let go, the way every
// real sidebar divider behaves. Above it the flick is thrown and lands on the
// bound it was heading for.
const FLICK_MIN_VELOCITY = 400

/**
 * Progressive resistance past a bound. A hard clamp reads as frozen; this
 * lets the pointer keep moving while the surface increasingly refuses to, so
 * the edge feels soft rather than stuck.
 */
function rubberband(overshoot: number, dimension = RUBBERBAND_DIMENSION, constant = RUBBERBAND_CONSTANT): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

function resist(width: number, maxWidth: number): number {
  if (width < SIDEBAR_MIN_WIDTH) return SIDEBAR_MIN_WIDTH - rubberband(SIDEBAR_MIN_WIDTH - width)
  if (width > maxWidth) return maxWidth + rubberband(width - maxWidth)
  return width
}

/**
 * Where a flick would come to rest, using the exponential decay Apple ships in
 * its scroll-deceleration sample rather than the physics-textbook form.
 */
function project(velocityPxPerSecond: number, decelerationRate = PROJECTION_DECELERATION): number {
  return (velocityPxPerSecond / 1000) * (decelerationRate / (1 - decelerationRate))
}
const CONTENT_MAX_WIDTH = 780
const TITLEBAR_CLEARANCE =
  typeof process !== 'undefined' && process.platform === 'darwin' ? 86 : 20

const ICONS = {
  activity: iconActivity,
  arrowLeft: iconArrowLeft,
  arrowUp: iconArrowUp,
  cpu: iconCpu,
  inbox: iconInbox,
  message: iconMessage,
  panelLeft: iconPanelLeft,
  plus: iconPlus,
  settings: iconSettings,
  shield: iconShield,
  sparkle: iconSparkle,
  terminal: iconTerminal,
  user: iconUser,
} as const

type IconName = keyof typeof ICONS
type MessageRole = 'user' | 'assistant'

type Message = {
  id: string
  role: MessageRole
  content: string
}

type ToolActivity = {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  output: string
}

type PendingInteraction =
  | { kind: 'approval'; toolCallId: string; toolName: string }
  | { kind: 'question'; questionId: string; question: string }


const VERSION = '0.1.0'
const HELP_TEXT = 'review, recap, last-response, /model, /reasoning, /permissions, /diff, /compact, /snapcompact, /export, /undo, /fork, /clone, /steer, /followup, /status, /stop'
const REVIEW_PROMPT = 'Review the current uncommitted changes in the workspace. Do not modify files. Identify bugs, regressions, security issues, and missing tests. Start with a concise summary and cite relevant file paths.'
const BUILTIN_COMMANDS: CommandSummary[] = [
  { name: 'help', description: 'Show command help' },
  { name: 'version', description: 'Show the version' },
  { name: 'review', description: 'Review uncommitted workspace changes' },
  { name: 'recap', description: 'Summarize the current session' },
  { name: 'last-response', description: 'Show the last persisted assistant response' },
]


function Icon({ name, size = 15, color }: { name: IconName; size?: number; color: string }) {
  return (
    <svg source={ICONS[name]} style={{ width: size, height: size, flexShrink: 0, color }} />
  )
}

function runButtonKey(event: { key?: string }, action?: () => void) {
  if (action && (event.key === 'enter' || event.key === ' ')) action()
}

function IconButton({
  icon,
  label,
  testId,
  onClick,
  color = C.tertiary,
  size = 16,
  active = false,
}: {
  icon: IconName
  label: string
  testId?: string
  onClick?: () => void
  color?: string
  size?: number
  active?: boolean
}) {
  return (
    <div
      testId={testId}
      role={onClick ? 'button' : undefined}
      aria-label={label}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (event) => runButtonKey(event, onClick) : undefined}
      style={{
        width: 38,
        height: 38,
        flexShrink: 0,
        borderRadius: 9,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: onClick ? 'pointer' : 'default',
        backgroundColor: active ? C.accentSoft : undefined,
        hover: onClick ? { backgroundColor: C.raised } : undefined,
        active: onClick ? { backgroundColor: C.raisedStrong, opacity: 0.9 } : undefined,
      }}
    >
      <Icon name={icon} size={size} color={active ? C.accent : color} />
    </div>
  )
}

function SidebarRow({
  icon,
  label,
  testId,
  active = false,
  nested = false,
  onClick,
}: {
  icon?: IconName
  label: string
  testId?: string
  active?: boolean
  nested?: boolean
  onClick?: () => void
}) {
  return (
    <div
      testId={testId}
      role={onClick ? 'button' : undefined}
      aria-label={label}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (event) => runButtonKey(event, onClick) : undefined}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 36,
        paddingLeft: nested ? 26 : 10,
        paddingRight: 10,
        borderRadius: 7,
        backgroundColor: active ? C.raised : undefined,
        cursor: onClick ? 'pointer' : 'default',
        hover: onClick && !active ? { backgroundColor: C.surfaceAlt } : undefined,
        active: onClick ? { backgroundColor: C.raisedStrong, opacity: 0.9 } : undefined,
      }}
    >
      {active ? (
        <div
          style={{
            width: 2,
            height: 18,
            marginLeft: -6,
            borderRadius: 1,
            backgroundColor: C.accent,
          }}
        />
      ) : null}
      {icon ? <Icon name={icon} size={15} color={active ? C.text : C.tertiary} /> : null}
      <text
        style={{
          flexGrow: 1,
          fontSize: 13,
          fontWeight: active ? 600 : 400,
          fontFamily: FONT,
          color: active ? C.text : C.secondary,
          whiteSpace: 'normal',
        }}
      >
        {label}
      </text>
    </div>
  )
}

function NewChatButton({ onClick }: { onClick: () => void }) {
  return (
    <div
      testId="new-chat"
      role="button"
      aria-label="Start a new chat"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => runButtonKey(event, onClick)}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 32,
        paddingLeft: 9,
        paddingRight: 9,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.surfaceAlt,
        cursor: 'pointer',
        hover: { backgroundColor: C.raised, borderColor: C.borderStrong },
        active: { backgroundColor: C.raisedStrong },
      }}
    >
      <Icon name="plus" size={13} color={C.secondary} />
      <text style={{ flexGrow: 1, fontSize: 12.5, fontWeight: 500, fontFamily: FONT, color: C.secondary }}>
        New chat
      </text>
    </div>
  )
}

type Space = {
  id: string
  name: string
  path: string
  sessions: SessionSummary[]
}

type RunningAgent = {
  path: string
  name: string
}

function Sidebar({
  currentTitle,
  hasMessages,
  spaces,
  agents,
  expanded,
  activeSessionPath,
  now,
  onToggleSpace,
  onSelectSession,
  onOpenAgent,
  onStopAgent,
  onNewChat,
  onSettings,
  width,
  maxWidth,
  onResize,
  resizing,
  setResizing,
}: {
  currentTitle: string
  hasMessages: boolean
  spaces: Space[]
  agents: RunningAgent[]
  expanded: Record<string, boolean>
  activeSessionPath: string | null
  now: number
  onToggleSpace: (id: string) => void
  onSelectSession: (session: SessionSummary) => void
  onOpenAgent: (path: string) => void
  onStopAgent: (session: SessionSummary) => void
  onNewChat: () => void
  onSettings: () => void
  width: number
  maxWidth: number
  onResize: (width: number) => void
  resizing: boolean
  setResizing: (value: boolean) => void
}) {
  const [settledExpanded, setSettledExpanded] = useStoredFlag(SETTLED_SHELF_KEY, false)
  // Settled sessions leave their project's list and gather at the bottom, so the
  // list you read every day stays short however much history exists.
  const settledSessions = spaces
    .flatMap((space) => space.sessions)
    .filter((session) => !agents.some((agent) => agent.path === session.path))
    .filter((session) => visibilityOf(session, now) === 'settled')
  const [dragStartX, setDragStartX] = useState(0)
  const [dragStartWidth, setDragStartWidth] = useState(width)
  // Pointer history for release velocity. GPUIX events carry no timestamp, so
  // the clock is read here; only the last few samples matter.
  const samples = useRef<Array<{ x: number; t: number }>>([])

  const startResize = (event: { x?: number; clientX?: number }) => {
    const startX = event.x ?? event.clientX ?? 0
    setResizing(true)
    setDragStartX(startX)
    setDragStartWidth(width)
    samples.current = [{ x: startX, t: Date.now() }]
  }

  const handleResize = (event: { x?: number; clientX?: number }) => {
    if (!resizing) return
    const currentX = event.x ?? event.clientX ?? dragStartX
    samples.current.push({ x: currentX, t: Date.now() })
    if (samples.current.length > 6) samples.current.shift()
    const raw = dragStartWidth + (currentX - dragStartX)
    onResize(resist(raw, maxWidth))
  }

  const endResize = () => {
    if (!resizing) return
    setResizing(false)
    // Momentum projection: a flick keeps going and lands on the bound it was
    // thrown toward. A slow release rests exactly where it was let go, and a
    // rubber-banded drag settles back to the edge it was pressing.
    const history = samples.current
    const first = history[0]
    const last = history[history.length - 1]
    const elapsed = last && first ? last.t - first.t : 0
    const velocity = elapsed > 0 && first && last ? ((last.x - first.x) / elapsed) * 1000 : 0
    // A rubber-banded drag is already committed to returning to its bound. Any
    // other release rests where the flick would have carried it, clamped.
    const flicked = Math.abs(velocity) >= FLICK_MIN_VELOCITY
    const settled =
      width < SIDEBAR_MIN_WIDTH
        ? SIDEBAR_MIN_WIDTH
        : width > maxWidth
          ? maxWidth
          : Math.max(SIDEBAR_MIN_WIDTH, Math.min(maxWidth, width + (flicked ? project(velocity) : 0)))
    onResize(Math.round(settled))
    samples.current = []
    storeSidebarWidth(Math.round(settled))
  }

  return (
    <div
      style={{
        width,
        height: '100%',
        flexShrink: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        paddingTop: TITLEBAR_CLEARANCE,
        userSelect: 'none',
        paddingLeft: 10,
        paddingRight: 10,
        paddingBottom: 10,
        backgroundColor: C.sidebar,
        borderRightWidth: 1,
        borderColor: C.border,
      }}
    >
      <text style={{ height: 34, paddingLeft: 9, paddingBottom: 7, fontSize: 14, fontWeight: 600, fontFamily: FONT, color: C.text, whiteSpace: 'nowrap' }}>Escape</text>

      <NewChatButton onClick={onNewChat} />

      <div style={{ height: 16 }} />

      {agents.length > 0 ? (
        <>
          {agents.map((agent) => (
            <div
              key={agent.path}
              testId={`agent-${agent.path}`}
              role="button"
              aria-label={`Open running session ${agent.name}`}
              tabIndex={0}
              onClick={() => onOpenAgent(agent.path)}
              onKeyDown={(event) => runButtonKey(event, () => onOpenAgent(agent.path))}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                minHeight: 34,
                paddingLeft: 9,
                paddingRight: 4,
                borderRadius: 7,
                marginBottom: 2,
                cursor: 'pointer',
                hover: { backgroundColor: C.surfaceAlt },
                active: { backgroundColor: C.raisedStrong },
              }}
            >
              <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: C.success, flexShrink: 0 }} />
              <text
                testId={`agent-name-${agent.path}`}
                style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 600, fontFamily: FONT, color: C.text, whiteSpace: 'nowrap' }}
              >
                {agent.name}
              </text>
              <div
                testId={`agent-stop-${agent.path}`}
                role="button"
                aria-label={`Stop agent ${agent.name}`}
                tabIndex={0}
                onClick={() => onStopAgent({ id: agent.path, path: agent.path, cwd: '', name: agent.name, updatedAt: Date.now() })}
                onKeyDown={(event) => runButtonKey(event, () => onStopAgent({ id: agent.path, path: agent.path, cwd: '', name: agent.name, updatedAt: Date.now() }))}
                style={{
                  width: 26, height: 26, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: C.raised, cursor: 'pointer',
                  hover: { backgroundColor: C.raisedStrong },
                  active: { backgroundColor: C.raisedStrong, opacity: 0.9 },
                }}
              >
                <text style={{ fontSize: 10, fontFamily: FONT, color: C.secondary }}>■</text>
              </div>
            </div>
          ))}
          <div style={{ height: 12 }} />
        </>
      ) : null}

      <div
        testId="sidebar-list"
        style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'scroll' }}
      >
        {spaces.map((space) => {
          const isOpen = expanded[space.id] !== false
          return (
            <div key={space.id} testId={`space-${space.id}`} style={{ marginBottom: 2 }}>
              <div
                testId={`space-toggle-${space.id}`}
                role="button"
                aria-expanded={isOpen}
                aria-label={`Toggle space ${space.name}`}
                tabIndex={0}
                onClick={() => onToggleSpace(space.id)}
                onKeyDown={(event) => runButtonKey(event, () => onToggleSpace(space.id))}
                style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34,
                  paddingLeft: 9, paddingRight: 9, borderRadius: 7, cursor: 'pointer',
                  hover: { backgroundColor: C.surfaceAlt },
                  active: { backgroundColor: C.raisedStrong },
                }}
              >
                <text style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 600, fontFamily: FONT, color: C.text, whiteSpace: 'nowrap' }}>{space.name}</text>
                <text style={{ fontSize: 11, fontFamily: FONT, color: C.ghost }}>{space.sessions.length || ''}</text>
              </div>
              {isOpen
                ? space.sessions
                    .filter((session) => !agents.some((agent) => agent.path === session.path))
                    .filter((session) => visibilityOf(session, now) === 'active')
                    .map((session) => (
                    <SidebarRow
                      key={session.path}
                      nested
                      label={session.name || 'Untitled session'}
                      testId={`session-row-${session.path}`}
                      active={session.path === activeSessionPath}
                      onClick={() => onSelectSession(session)}
                    />
                  ))
                : null}
            </div>
          )
        })}
        {hasMessages && !activeSessionPath ? <SidebarRow label={currentTitle} active testId="current-chat" /> : null}
        {!spaces.length && !hasMessages ? (
          <text style={{ paddingLeft: 9, paddingTop: 6, paddingBottom: 6, fontSize: 12, lineHeight: 18, fontFamily: FONT, color: C.ghost, whiteSpace: 'normal' }}>
            Start a chat to create your first space.
          </text>
        ) : null}
      </div>

      {settledSessions.length > 0 ? (
          <div testId="settled-shelf" style={{ flexShrink: 0, paddingTop: 10 }}>
            <div
              testId="settled-shelf-header"
              role="button"
              tabIndex={0}
              aria-expanded={settledExpanded}
              aria-label={`${settledExpanded ? 'Collapse' : 'Expand'} settled sessions`}
              onClick={() => setSettledExpanded(!settledExpanded)}
              onKeyDown={(event) => runButtonKey(event, () => setSettledExpanded(!settledExpanded))}
              style={{
                display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6,
                minHeight: 26, paddingLeft: 9, paddingRight: 9, borderRadius: 7,
                cursor: 'pointer', hover: { backgroundColor: C.surfaceAlt },
                active: { backgroundColor: C.raisedStrong },
              }}
            >
              <text
                style={{
                  flexGrow: 1, fontSize: 11, fontWeight: 600, fontFamily: FONT,
                  color: C.tertiary, whiteSpace: 'nowrap',
                }}
              >
                {settledExpanded ? 'Settled' : `Settled (${settledSessions.length})`}
              </text>
              <Icon name={settledExpanded ? 'arrowUp' : 'inbox'} size={12} color={C.ghost} />
            </div>
            {settledExpanded
              ? settledSessions.map((session) => (
                  <SidebarRow
                    key={session.path}
                    nested
                    label={session.name || 'Untitled session'}
                    testId={`settled-row-${session.path}`}
                    active={session.path === activeSessionPath}
                    onClick={() => onSelectSession(session)}
                  />
                ))
              : null}
          </div>
        ) : null}

      <div style={{ flexShrink: 0, borderTopWidth: 1, borderColor: C.border, paddingTop: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="settings" label="Workspace settings" size={15} testId="settings" onClick={onSettings} />
      </div>

      <div
        testId="sidebar-resize-handle"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onMouseDown={startResize}
        onMouseMove={handleResize}
        onMouseUp={endResize}
        onMouseLeave={endResize}
        style={{
          position: 'absolute',
          top: 0,
          right: -3,
          width: 6,
          height: '100%',
          cursor: resizing ? 'ew-resize' : 'col-resize',
          backgroundColor: resizing ? C.accentSoft : 'transparent',
          borderRadius: 3,
        }}
      />
    </div>
  )
}

function Welcome() {
  return (
    <div
      style={{
        flexGrow: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 18,
        paddingBottom: 28,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <text
          role="heading"
          aria-level={1}
          style={{
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 28,
            fontFamily: FONT,
            color: C.text,
            textAlign: 'center',
          }}
        >
          What can I help you with?
        </text>
      </div>
    </div>
  )
}


function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  // t3code model: the user's prompt is a compact right-aligned bubble
  // (max 80%); the assistant's output is flat, full-width, and scanned
  // top-to-bottom. No avatar chip on assistant rows.
  if (isUser) {
    return (
      <div
        testId={`message-${message.id}`}
        style={{
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'flex-end',
          width: '100%',
          paddingTop: 4,
          paddingBottom: 4,
        }}
      >
        <div
          style={{
            maxWidth: '80%',
            minWidth: 0,
            paddingLeft: 14,
            paddingRight: 14,
            paddingTop: 9,
            paddingBottom: 9,
            borderRadius: 14,
            backgroundColor: C.raised,
            borderWidth: 1,
            borderColor: C.border,
          }}
        >
          <text style={{ fontSize: 14, lineHeight: 21, fontFamily: FONT, color: C.text, whiteSpace: 'normal' }}>
            {message.content}
          </text>
        </div>
      </div>
    )
  }

  return (
    <div
      testId={`message-${message.id}`}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        paddingTop: 10,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderColor: C.border,
      }}
    >
      <div style={{ width: 18, flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: 2 }}>
        <Icon name="sparkle" size={13} color={C.tertiary} />
      </div>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <text style={{ fontSize: 14, lineHeight: 22, fontFamily: FONT, color: C.text, whiteSpace: 'normal' }}>
          {message.content}
        </text>
      </div>
    </div>
  )
}

/**
 * Built-in commands first, then engine commands, with the engine winning on a
 * shared name. Concatenating them showed "help" twice whenever the engine also
 * reported it.
 */
function mergeCommands(builtins: CommandSummary[], fromEngine: CommandSummary[]): CommandSummary[] {
  const byName = new Map<string, CommandSummary>()
  for (const command of builtins) byName.set(command.name, command)
  for (const command of fromEngine) byName.set(command.name, command)
  return [...byName.values()]
}

function SessionTreePanel({ nodes, onFork }: { nodes: SessionTreeNode[]; onFork: (entryId: string) => void }) {
  const renderNodes = (items: SessionTreeNode[], depth = 0): ReactNode[] => items.flatMap((node) => [
    <div key={node.entryId} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5, marginLeft: depth * 12 }}>
      <text style={{ flexGrow: 1, fontSize: 10, fontFamily: FONT, color: node.role === 'user' ? C.accent : C.secondary, whiteSpace: 'normal' }}>{node.text || node.entryId}</text>
      {node.role === 'user' ? <div testId={`tree-fork-${node.entryId}`} role="button" aria-label={`Fork from ${node.text || node.entryId}`} tabIndex={0} onClick={() => onFork(node.entryId)} onKeyDown={(event) => runButtonKey(event, () => onFork(node.entryId))} style={{ paddingTop: 3, paddingRight: 5, paddingBottom: 3, paddingLeft: 5, borderRadius: 5, backgroundColor: C.raised, cursor: 'pointer' }}><text style={{ fontSize: 9, fontFamily: FONT, color: C.secondary }}>Fork</text></div> : null}
    </div>,
    ...renderNodes(node.children, depth + 1),
  ])
  return <div testId="session-tree" style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>{renderNodes(nodes)}</div>
}

function readStoredSidebarWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    const parsed = raw === null || raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** A boolean persisted in localStorage, for view state the engine owns nothing of. */
function useStoredFlag(key: string, initial: boolean): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(key)
      return raw === null || raw === undefined ? initial : raw === '1'
    } catch {
      return initial
    }
  })
  const set = (next: boolean) => {
    setValue(next)
    try {
      globalThis.localStorage?.setItem(key, next ? '1' : '0')
    } catch {
      // View state is optional; the session still works without it.
    }
  }
  return [value, set]
}

function storeSidebarWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // Storage is optional (e.g. background/test renders); width still applies
    // for the current session.
  }
}

/**
 * Settings surfaces follow the grouped-row pattern: a bordered card whose rows
 * are split by hairlines, each with a label block on the left and the control on
 * the right. A plain scroll container owns the vertical scroll, so no descendant
 * may also scroll (nested scrolling is unsupported on GPUIX).
 */
function projectLabel(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function SettingsCard({ children }: { children?: ReactNode }) {
  return (
    <div
      testId="settings-card"
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.surface,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  )
}

function SettingsRow({
  label,
  description,
  children,
  testId,
  column = false,
}: {
  label: string
  description?: string
  children?: ReactNode
  testId?: string
  column?: boolean
}) {
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        flexDirection: column ? 'column' : 'row',
        alignItems: column ? 'stretch' : 'center',
        gap: column ? 10 : 16,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 13,
        paddingBottom: 13,
        borderBottomWidth: 1,
        borderColor: C.border,
      }}
    >
      <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <text style={{ fontSize: 13.5, fontWeight: 600, fontFamily: FONT, color: C.text, whiteSpace: 'normal' }}>{label}</text>
        {description ? (
          <text style={{ fontSize: 12, lineHeight: 17, fontFamily: FONT, color: C.tertiary, whiteSpace: 'normal' }}>{description}</text>
        ) : null}
      </div>
      {children ? (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

function SettingSwitch({
  checked,
  onChange,
  testId,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  testId?: string
  label: string
}) {
  return (
    <div
      testId={testId}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={(event) => runButtonKey(event, () => onChange(!checked))}
      style={{
        width: 42,
        height: 25,
        borderRadius: 13,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: checked ? 19 : 2,
        paddingRight: 2,
        backgroundColor: checked ? C.accent : C.raised,
        cursor: 'pointer',
        hover: { backgroundColor: checked ? C.accent : C.raisedStrong },
      }}
    >
      <div
        style={{
          width: 21,
          height: 21,
          borderRadius: 11,
          backgroundColor: '#FFFFFF',
          boxShadow: { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: '#00000055' },
        }}
      />
    </div>
  )
}

function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children?: unknown
}) {
  return (
    <div
      testId={`settings-section-${title.toLowerCase().replace(/\s+/g, '-')}`}
      style={{
        marginTop: 12,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.surfaceAlt,
      }}
    >
      <text style={{ fontSize: 13, fontWeight: 600, fontFamily: FONT, color: C.text }}>{title}</text>
      {hint ? <text style={{ marginTop: 2, fontSize: 11.5, lineHeight: 16, fontFamily: FONT, color: C.tertiary, whiteSpace: 'normal' }}>{hint}</text> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>{children as never}</div>
    </div>
  )
}

function SettingChip({
  label,
  active,
  onClick,
  testId,
  disabled,
}: {
  label: string
  active: boolean
  onClick: () => void
  testId?: string
  disabled?: boolean
}) {
  return (
    <div
      testId={testId}
      role="button"
      aria-label={label}
      aria-pressed={active}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => runButtonKey(event, onClick)}
      style={{
        minHeight: 32,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: active ? C.accent : C.border,
        backgroundColor: active ? C.accentSoft : C.surface,
        cursor: 'pointer',
        opacity: disabled ? 0.5 : 1,
        hover: { backgroundColor: active ? C.accentSoft : C.raised },
        active: { backgroundColor: active ? C.accentSoft : C.raisedStrong },
      }}
    >
      <text style={{ fontSize: 12, fontWeight: active ? 500 : 400, fontFamily: FONT, color: active ? C.text : C.secondary }}>{label}</text>
    </div>
  )
}

function SettingsAction({
  label,
  onClick,
  testId,
  primary,
  disabled,
}: {
  label: string
  onClick: () => void
  testId?: string
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <div
      testId={testId}
      role="button"
      aria-label={label}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => runButtonKey(event, onClick)}
      style={{
        minHeight: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? C.accent : C.border,
        backgroundColor: primary ? C.accent : C.surface,
        cursor: 'pointer',
        opacity: disabled ? 0.5 : 1,
        hover: { backgroundColor: primary ? C.accentHover : C.raised },
        active: { backgroundColor: primary ? C.accentPressed : C.raisedStrong },
      }}
    >
      <text style={{ fontSize: 12, fontWeight: 500, fontFamily: FONT, color: primary ? C.onAccent : C.secondary }}>{label}</text>
    </div>
  )
}

const DRAFT_SESSION_KEY = '__draft__'

function basenameOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return 'Workspace'
  return parts[parts.length - 1] || 'Workspace'
}

function omitKey(record: Record<string, boolean>, key: string): Record<string, boolean> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}

type SettingsSectionId = 'session' | 'model' | 'memory' | 'skills' | 'approvals' | 'account' | 'diagnostics' | 'developer' | 'keyboard'

const SETTINGS_SECTIONS: Array<{ id: SettingsSectionId; label: string; icon: IconName }> = [
  { id: 'session', label: 'Session', icon: 'message' },
  { id: 'model', label: 'Model', icon: 'cpu' },
  { id: 'memory', label: 'Memory', icon: 'message' },
  { id: 'skills', label: 'Skills', icon: 'sparkle' },
  { id: 'approvals', label: 'Approvals and queue', icon: 'shield' },
  { id: 'account', label: 'Account', icon: 'user' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'activity' },
  { id: 'developer', label: 'Developer tools', icon: 'terminal' },
  { id: 'keyboard', label: 'Keyboard', icon: 'activity' },
]

const SETTINGS_SECTION_COPY: Record<SettingsSectionId, { title: string; hint: string }> = {
  session: { title: 'Session', hint: 'Open a specific session file or give the current one a name.' },
  model: { title: 'Model', hint: 'Provider, model, and reasoning effort for new turns.' },
  memory: {
    title: 'Memory',
    hint: 'Notes the agent keeps for this project. They survive session end and are never compacted, so anything important belongs here rather than in a transcript.',
  },
  approvals: { title: 'Approvals and queue', hint: 'When the agent asks, and how queued messages are handled.' },
  account: { title: 'Account', hint: 'Keys are saved by the engine in a private credential store, never in the app.' },
  diagnostics: { title: 'Diagnostics', hint: 'Engine connectivity and session usage.' },
  developer: { title: 'Developer tools', hint: 'Diff, compaction, history, and direct shell access.' },
  skills: {
    title: 'Skills',
    hint: 'A skill you switch off is not offered to the model at all, and stops costing prompt tokens. It stays on disk.',
  },
  keyboard: {
    title: 'Keyboard',
    hint: 'There is no menu bar, so these are the complete set of window commands.',
  },
}

function SettingsPanel({
  provider,
  providers,
  approvalMode,
  autoCompaction,
  autoRetry,
  steeringMode,
  followUpMode,
  maxTokens,
  model,
  models,
  reasoning,
  reasoningLevels,
  stats,
  tree,
  bashCommand,
  bashOutput,
  bashRunning,
  diffOutput,
  exportedPath,
  compactionSummary,
  branchMessage,
  loginProvider,
  loginKey,
  loginStatus,
  sessionPath,
  sessionName,
  onSessionPath,
  onSessionName,
  onSwitchSession,
  onRenameSession,
  onLoginProvider,
  onLoginKey,
  onSaveLogin,
  connectionStatus,
  runtimeState,
  onPing,
  diagnostics,
  diagnosticsStatus,
  onCaptureDiagnostics,
  onSaveDiagnostics,
  onExport,
  onForkLatest,
  onForkEntry,
  onLoadTree,
  onBashCommand,
  onRunBash,
  onAbortBash,
  onGetDiff,
  onClone,
  onUndo,
  onCompact,
  onSnapcompact,
  onProvider,
  onApprovalMode,
  onAutoCompaction,
  onAutoRetry,
  onSteeringMode,
  onMaxTokens,
  onSetMaxTokens,
  onFollowUpMode,
  onModel,
  onReasoning,
  onClose,
  memoryState,
  memoryDraft,
  memoryEditing,
  memoryError,
  onMemoryDraft,
  onMemoryEdit,
  onMemoryCancel,
  onMemorySubmit,
  onMemoryRemove,
  skills,
  visibleSkills,
  skillProjects,
  skillsError,
  skillPending,
  skillScope,
  onSkillScope,
  onSkillToggle,
  section,
  onSection,
}: {
  provider: string
  providers: ProviderSummary[]
  approvalMode: string
  autoCompaction: boolean
  autoRetry: boolean
  steeringMode: string
  followUpMode: string
  maxTokens: number
  model: string
  models: string[]
  reasoning: string
  reasoningLevels: string[]
  stats: SessionStats | null
  tree: SessionTreeNode[]
  bashCommand: string
  bashOutput: string
  bashRunning: boolean
  diffOutput: string
  exportedPath: string
  compactionSummary: string
  branchMessage: string
  loginProvider: 'opencode-go' | 'opencode-zen'
  loginKey: string
  loginStatus: string
  sessionPath: string
  sessionName: string
  onSessionPath: (value: string) => void
  onSessionName: (value: string) => void
  onSwitchSession: () => void
  onRenameSession: () => void
  onLoginProvider: (provider: 'opencode-go' | 'opencode-zen') => void
  onLoginKey: (value: string) => void
  onSaveLogin: () => void
  connectionStatus: string
  runtimeState: string
  onPing: () => void
  diagnostics: Diagnostics | null
  diagnosticsStatus: string
  onCaptureDiagnostics: () => void
  onSaveDiagnostics: () => void
  onExport: () => void
  onForkLatest: () => void
  onForkEntry: (entryId: string) => void
  onLoadTree: () => void
  onBashCommand: (value: string) => void
  onRunBash: () => void
  onAbortBash: () => void
  onGetDiff: () => void
  onClone: () => void
  onUndo: () => void
  onCompact: () => void
  onSnapcompact: () => void
  onProvider: (provider: string) => void
  onApprovalMode: (mode: 'auto' | 'ask') => void
  onAutoCompaction: (enabled: boolean) => void
  onAutoRetry: (enabled: boolean) => void
  onSteeringMode: (mode: string) => void
  onMaxTokens: (value: string) => void
  onSetMaxTokens: () => void
  onFollowUpMode: (mode: string) => void
  onModel: (model: string) => void
  onReasoning: (level: string) => void
  onClose: () => void
  memoryState: MemorySnapshot
  memoryDraft: string
  memoryEditing: { index: number } | null
  memoryError: string
  onMemoryDraft: (value: string) => void
  onMemoryEdit: (index: number, text: string) => void
  onMemoryCancel: () => void
  onMemorySubmit: () => void
  onMemoryRemove: (index: number) => void
  skills: SkillSummary[]
  visibleSkills: SkillSummary[]
  skillProjects: SkillProject[]
  skillsError: string
  skillPending: boolean
  skillScope: string
  onSkillScope: (scope: string) => void
  onSkillToggle: (skill: SkillSummary, enabled: boolean) => void
  section: SettingsSectionId
  onSection: (id: SettingsSectionId) => void
}) {
  const copy = SETTINGS_SECTION_COPY[section]

  return (
    <div
      testId="settings-panel"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'stretch',
        backgroundColor: C.canvas,
      }}
    >
      <div
        style={{
          width: 248,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          paddingTop: TITLEBAR_CLEARANCE,
          paddingLeft: 12,
          paddingRight: 12,
          paddingBottom: 16,
          backgroundColor: C.sidebar,
          borderRightWidth: 1,
          borderColor: C.border,
          userSelect: 'none',
        }}
      >
        <div
          testId="settings-back"
          role="button"
          tabIndex={0}
          onClick={onClose}
          onKeyDown={(event) => runButtonKey(event, onClose)}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 30,
            paddingLeft: 8,
            borderRadius: 7,
            cursor: 'pointer',
            hover: { backgroundColor: C.raised },
            active: { backgroundColor: C.raisedStrong },
          }}
        >
          <Icon name="arrowLeft" size={14} color={C.secondary} />
          <text style={{ fontSize: 12.5, fontFamily: FONT, color: C.secondary }}>Back to app</text>
        </div>

        <text
          style={{
            marginTop: 16,
            marginBottom: 6,
            paddingLeft: 8,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: FONT,
            color: C.ghost,
          }}
        >
          Settings
        </text>

        <div testId="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {SETTINGS_SECTIONS.map((item) => {
            const active = section === item.id
            return (
              <div
                key={item.id}
                testId={`settings-tab-${item.id}`}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => onSection(item.id)}
                onKeyDown={(event) => runButtonKey(event, () => onSection(item.id))}
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  height: 30,
                  paddingLeft: 8,
                  paddingRight: 8,
                  borderRadius: 7,
                  cursor: 'pointer',
                  backgroundColor: active ? C.raised : 'transparent',
                  hover: { backgroundColor: active ? C.raised : C.surfaceAlt },
                  active: { backgroundColor: active ? C.raisedStrong : C.surfaceAlt },
                }}
              >
                <Icon name={item.icon} size={14} color={active ? C.text : C.tertiary} />
                <text
                  style={{
                    fontSize: 12.5,
                    fontWeight: active ? 600 : 400,
                    fontFamily: FONT,
                    color: active ? C.text : C.secondary,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.label}
                </text>
              </div>
            )
          })}
        </div>
      </div>

      <div
        style={{
          flexGrow: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          paddingTop: TITLEBAR_CLEARANCE,
          paddingBottom: 24,
          overflow: 'scroll',
        }}
      >
        <div style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', paddingLeft: 40, paddingRight: 40 }}>
          <text testId="settings-title" style={{ fontSize: 26, fontWeight: 650, fontFamily: FONT, color: C.text }}>{copy.title}</text>
          <text
            testId="settings-hint"
            style={{
              marginTop: 4,
              marginBottom: 20,
              fontSize: 12.5,
              lineHeight: 18,
              fontFamily: FONT,
              color: C.tertiary,
              whiteSpace: 'normal',
            }}
          >
            {copy.hint}
          </text>
        </div>
        <div style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', paddingLeft: 40, paddingRight: 40 }}>

      {section === 'session' ? (
        <SettingsCard>
          <SettingsRow label="Session file" description="Open a session from an absolute path." testId="settings-row-session-path" column>
            <input testId="session-path" aria-label="Session file path" value={sessionPath} placeholder="/path/to/session.jsonl" onChange={(event) => onSessionPath(event.value ?? '')} theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }} style={{ minHeight: 32, paddingLeft: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.surfaceAlt, fontSize: 12, fontFamily: MONO_FONT, color: C.text }} />
            <SettingsAction label="Open session" testId="switch-session-path" onClick={onSwitchSession} primary />
          </SettingsRow>
          <SettingsRow label="Session name" description="Shown in the sidebar and in exports." testId="settings-row-session-name" column>
            <input testId="session-name" aria-label="Session name" value={sessionName} placeholder="Session name" onChange={(event) => onSessionName(event.value ?? '')} theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }} style={{ minHeight: 32, paddingLeft: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.surfaceAlt, fontSize: 12, fontFamily: FONT, color: C.text }} />
            <SettingsAction label="Save name" testId="rename-session" onClick={onRenameSession} />
          </SettingsRow>
        </SettingsCard>
      ) : null}

      {section === 'model' ? (
        <SettingsCard>
          <SettingsRow label="Provider" description="Where turns are sent." testId="settings-row-provider" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {providers.map((o) => <SettingChip key={o.id} testId={`provider-option-${o.id}`} label={o.name} active={o.id === provider} disabled={!o.configured} onClick={() => onProvider(o.id)} />)}
            </div>
          </SettingsRow>
          <SettingsRow label="Model" description="Used for new turns in this session." testId="settings-row-model" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {models.slice(0, 8).map((o) => <SettingChip key={o} testId={`model-option-${o}`} label={o} active={o === model} onClick={() => onModel(o)} />)}
            </div>
          </SettingsRow>
          <SettingsRow label="Reasoning effort" description="Higher effort spends more tokens per turn." testId="settings-row-reasoning" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {reasoningLevels.map((l) => <SettingChip key={l} testId={`reasoning-option-${l}`} label={l} active={l === reasoning} onClick={() => onReasoning(l)} />)}
            </div>
          </SettingsRow>
          <SettingsRow label="Max output tokens" description="Leave empty to use the provider default." testId="settings-row-max-tokens">
            <input testId="max-tokens" aria-label="Maximum output tokens" value={maxTokens === 0 ? '' : String(maxTokens)} placeholder="Default" onChange={(event) => onMaxTokens(event.value ?? '')} onSubmit={onSetMaxTokens} theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }} style={{ width: 120, minHeight: 32, paddingLeft: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.surfaceAlt, fontSize: 12, fontFamily: MONO_FONT, color: C.text }} />
            <SettingsAction label="Set" testId="set-max-tokens" onClick={onSetMaxTokens} />
          </SettingsRow>
        </SettingsCard>
      ) : null}

      {section === 'memory' ? (
        <SettingsCard>
          <SettingsRow
            label="Usage"
            description={`${memoryState.used} of ${memoryState.max} characters. A write past the cap is rejected, so shorten or remove something first.`}
            testId="settings-row-memory-usage"
          >
            <div
              testId="memory-usage-bar"
              style={{ width: 120, height: 6, borderRadius: 3, backgroundColor: C.raised, overflow: 'hidden' }}
            >
              <div
                style={{
                  width: `${Math.min(100, Math.round((memoryState.used / Math.max(1, memoryState.max)) * 100))}%`,
                  height: '100%',
                  backgroundColor: memoryState.used > memoryState.max * 0.85 ? C.error : C.accent,
                }}
              />
            </div>
          </SettingsRow>
          {memoryState.entries.map((entry, index) => (
            <SettingsRow
              key={`${index}-${entry.slice(0, 12)}`}
              label={`Note ${index + 1}`}
              testId={`memory-entry-${index + 1}`}
              column
            >
              <text
                style={{
                  fontSize: 12.5,
                  lineHeight: 18,
                  fontFamily: FONT,
                  color: C.text,
                  whiteSpace: 'normal',
                }}
              >
                {entry}
              </text>
              <SettingsAction
                label="Edit"
                testId={`memory-edit-${index + 1}`}
                onClick={() => onMemoryEdit(index + 1, entry)}
              />
              <SettingsAction
                label="Remove"
                testId={`memory-remove-${index + 1}`}
                onClick={() => onMemoryRemove(index + 1)}
              />
            </SettingsRow>
          ))}
          {memoryState.entries.length === 0 ? (
            <SettingsRow
              label="No notes yet"
              description="The agent writes here when it learns something worth keeping across sessions."
              testId="memory-empty"
            />
          ) : null}
          <SettingsRow
            label={memoryEditing ? `Edit note ${memoryEditing.index}` : 'Add a note'}
            description="Keep it short. This is the part that survives everything."
            testId="settings-row-memory-add"
            column
          >
            <input
              testId="memory-input"
              aria-label={memoryEditing ? `Edit note ${memoryEditing.index}` : 'New note'}
              value={memoryDraft}
              placeholder="A decision, a convention, where something lives"
              onChange={(event) => onMemoryDraft(event.value ?? '')}
              onSubmit={onMemorySubmit}
              theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }}
              style={{
                minHeight: 32,
                paddingLeft: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: C.border,
                backgroundColor: C.surfaceAlt,
                fontSize: 12,
                fontFamily: FONT,
                color: C.text,
              }}
            />
            <SettingsAction
              label={memoryEditing ? 'Save note' : 'Add note'}
              testId="memory-save"
              onClick={onMemorySubmit}
              primary
            />
            {memoryEditing ? (
              <SettingsAction
                label="Cancel"
                testId="memory-cancel"
                onClick={onMemoryCancel}
              />
            ) : null}
            {memoryError ? (
              <text testId="memory-error" style={{ fontSize: 11, fontFamily: FONT, color: C.error }}>{memoryError}</text>
            ) : null}
          </SettingsRow>
        </SettingsCard>
      ) : null}

      {section === 'keyboard' ? (
        <SettingsCard>
          {SHORTCUTS.map((shortcut) => (
            <SettingsRow
              key={shortcut.command}
              label={shortcut.label}
              testId={`shortcut-${shortcut.command}`}
            >
              <text
                style={{
                  fontSize: 12,
                  fontFamily: MONO_FONT,
                  color: C.secondary,
                  whiteSpace: 'nowrap',
                }}
              >
                {shortcut.keys}
              </text>
            </SettingsRow>
          ))}
        </SettingsCard>
      ) : null}

      {section === 'skills' ? (
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 16 }}>
          <div
            testId="skills-scope-column"
            style={{
              width: 188,
              flexShrink: 0,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: C.border,
              backgroundColor: C.surface,
              overflow: 'hidden',
            }}
          >
            <text
              style={{
                paddingLeft: 14,
                paddingRight: 14,
                paddingTop: 12,
                paddingBottom: 4,
                fontSize: 10.5,
                fontWeight: 600,
                fontFamily: FONT,
                color: C.ghost,
              }}
            >
              Applies to
            </text>
            {[{ path: SKILL_SCOPE_GLOBAL, name: 'Everywhere' }, ...skillProjects].map((scope) => {
              const active = skillScope === scope.path
              return (
                <div
                  key={scope.path}
                  testId={`skill-scope-${scope.name}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={active}
                  aria-label={`Show skills for ${scope.name}`}
                  onClick={() => onSkillScope(scope.path)}
                  onKeyDown={(event) => runButtonKey(event, () => onSkillScope(scope.path))}
                  style={{
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    minHeight: 32,
                    paddingLeft: 14,
                    paddingRight: 14,
                    cursor: 'pointer',
                    backgroundColor: active ? C.raised : 'transparent',
                    hover: { backgroundColor: C.surfaceAlt },
                    active: { backgroundColor: C.raisedStrong },
                  }}
                >
                  <text
                    style={{
                      flexGrow: 1,
                      minWidth: 0,
                      fontSize: 12.5,
                      fontWeight: active ? 600 : 400,
                      fontFamily: FONT,
                      color: active ? C.text : C.secondary,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {scope.name}
                  </text>
                </div>
              )
            })}
          </div>

          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <SettingsCard>
              {skillsError ? (
                <SettingsRow
                  label="Could not load skills"
                  description={skillsError}
                  testId="skills-error"
                />
              ) : null}
              {!skillsError && visibleSkills.length === 0 ? (
                <SettingsRow
                  label="No skills apply here"
                  description={
                    skillScope === SKILL_SCOPE_GLOBAL
                      ? 'Skills are markdown files with frontmatter, discovered under the user and project skills directories.'
                      : 'This project has no skills of its own, so it inherits the global list.'
                  }
                  testId="skills-empty"
                />
              ) : null}
              {visibleSkills.map((skill) => {
                const override = skill.overrides.find((o) => o.project === skillScope)
                const state = skillScope === SKILL_SCOPE_GLOBAL
                  ? skill.globalEnabled
                  : (override?.enabled ?? skill.globalEnabled)
                const inherited = skillScope !== SKILL_SCOPE_GLOBAL && override === undefined
                return (
                  <SettingsRow
                    key={skill.path}
                    label={skill.name}
                    description={skill.description}
                    testId={`skill-${skill.name}`}
                  >
                    <text
                      testId={`skill-scope-state-${skill.name}`}
                      style={{ fontSize: 10.5, fontFamily: FONT, color: C.ghost, whiteSpace: 'nowrap' }}
                    >
                      {inherited ? (state ? 'inherited: on' : 'inherited: off') : 'set here'}
                    </text>
                    <SettingSwitch
                      testId={`skill-toggle-${skill.name}`}
                      label={`${state ? 'Disable' : 'Enable'} ${skill.name}`}
                      checked={state}
                      onChange={(next) => onSkillToggle(skill, next)}
                    />
                  </SettingsRow>
                )
              })}
              {skillPending ? (
                <SettingsRow
                  label="Applies on your next turn"
                  description="The system prompt is fixed while a turn is running, so this takes effect once the current turn settles."
                  testId="skill-pending"
                />
              ) : null}
            </SettingsCard>
          </div>
        </div>
      ) : null}

      {section === 'approvals' ? (
        <SettingsCard>
          <SettingsRow label="Approval mode" description="Whether tool approval is required." testId="settings-row-approval" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <SettingChip testId="approval-mode-auto" label="auto" active={approvalMode === 'auto'} onClick={() => onApprovalMode('auto')} />
              <SettingChip testId="approval-mode-ask" label="ask" active={approvalMode === 'ask'} onClick={() => onApprovalMode('ask')} />
            </div>
          </SettingsRow>
          <SettingsRow label="Auto compaction" description="Summarise the session when the context fills." testId="settings-row-auto-compaction">
            <SettingSwitch testId="auto-compaction" label="Auto compaction" checked={autoCompaction} onChange={onAutoCompaction} />
          </SettingsRow>
          <SettingsRow label="Auto retry" description="Retry a turn that failed upstream." testId="settings-row-auto-retry">
            <SettingSwitch testId="auto-retry" label="Auto retry" checked={autoRetry} onChange={onAutoRetry} />
          </SettingsRow>
          <SettingsRow label="Steering" description="How a message sent mid-turn reaches the running agent." testId="settings-row-steering" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(['all', 'one-at-a-time'] as const).map((m) => <SettingChip key={`s-${m}`} testId={`steering-mode-${m}`} label={m} active={m === steeringMode} onClick={() => onSteeringMode(m)} />)}
            </div>
          </SettingsRow>
          <SettingsRow label="Follow up" description="How queued messages are handed to the agent." testId="settings-row-follow-up" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {(['all', 'one-at-a-time'] as const).map((m) => <SettingChip key={`f-${m}`} testId={`follow-up-mode-${m}`} label={m} active={m === followUpMode} onClick={() => onFollowUpMode(m)} />)}
            </div>
          </SettingsRow>
        </SettingsCard>
      ) : null}

      {section === 'account' ? (
        <SettingsCard>
          <SettingsRow label="Sign in with" description="Stored in its own credential store." testId="settings-row-login-provider" column>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              <SettingChip testId="login-provider-opencode-go" label="opencode-go" active={loginProvider === 'opencode-go'} onClick={() => onLoginProvider('opencode-go')} />
              <SettingChip testId="login-provider-opencode-zen" label="opencode-zen" active={loginProvider === 'opencode-zen'} onClick={() => onLoginProvider('opencode-zen')} />
            </div>
          </SettingsRow>
          <SettingsRow label="API key" description="Used when the provider has no browser login." testId="settings-row-api-key" column>
            <input testId="provider-api-key" aria-label="OpenCode API key" value={loginKey} placeholder="API key" onChange={(event) => onLoginKey(event.value ?? '')} theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }} style={{ minHeight: 32, paddingLeft: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.surfaceAlt, fontSize: 12, fontFamily: MONO_FONT, color: C.text }} />
            <SettingsAction label="Save" testId="save-api-key" onClick={onSaveLogin} primary />
            {loginStatus ? <text testId="login-status" style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{loginStatus}</text> : null}
          </SettingsRow>
        </SettingsCard>
      ) : null}

      {section === 'diagnostics' ? (
        <SettingsCard>
          <SettingsRow label="Engine connection" description="Ping the engine over stdio RPC." testId="settings-row-connection" column>
            <text testId="runtime-state" style={{ fontSize: 11, fontFamily: FONT, color: C.tertiary }}>{`Engine state: ${runtimeState || 'unknown'}`}</text>
            <SettingsAction label="Test connection" testId="ping-engine" onClick={onPing} />
            {connectionStatus ? <text testId="connection-status" style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{connectionStatus}</text> : null}
          </SettingsRow>
          <SettingsRow
            label="Turn timings"
            description="Measured by the engine on every turn. Read and build grow with the session; first token is the network and the model."
            testId="settings-row-timings"
            column
          >
            <SettingsAction label={diagnostics ? 'Refresh timings' : 'Read timings'} testId="capture-diagnostics" onClick={onCaptureDiagnostics} />
            <SettingsAction label="Save report" testId="save-diagnostics" onClick={onSaveDiagnostics} />
            {diagnosticsStatus ? <text testId="diagnostics-status" style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{diagnosticsStatus}</text> : null}
            {diagnostics ? (
              <div testId="diagnostics-timings" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                <text style={{ fontSize: 11, fontFamily: FONT, color: C.tertiary }}>
                  {`${diagnostics.model ?? 'unknown model'} on ${diagnostics.provider ?? 'unknown provider'} · thinking ${diagnostics.thinkingLevel || 'unset'} · ${diagnostics.skills ?? 0} skills · ${diagnostics.tools ?? 0} tools`}
                </text>
                <text style={{ fontSize: 11, fontFamily: MONO_FONT, color: C.secondary }}>
                  {`first token p50 ${diagnostics.firstTokenP50Ms ?? 0}ms · p95 ${diagnostics.firstTokenP95Ms ?? 0}ms · context window ${diagnostics.contextWindow ?? 0}`}
                </text>
                {diagnostics.sessionSizeBytes ? (
                  <text style={{ fontSize: 11, fontFamily: MONO_FONT, color: C.tertiary }}>
                    {`session ${diagnostics.sessionEntries ?? 0} entries · ${Math.round(diagnostics.sessionSizeBytes / 1024)} KB`}
                  </text>
                ) : null}
                {diagnostics.lastError ? (
                  <text testId="diagnostics-error" style={{ fontSize: 11, fontFamily: MONO_FONT, color: C.error }}>{`last error: ${diagnostics.lastError}`}</text>
                ) : null}
                {(diagnostics.turns ?? []).slice(-6).map((turn, index) => (
                  <text key={index} style={{ fontSize: 11, fontFamily: MONO_FONT, color: C.tertiary }}>
                    {`#${(diagnostics.turns ?? []).length - Math.min((diagnostics.turns ?? []).length, 6) + index + 1} read ${turn.historyReadMs ?? 0}ms · build ${turn.buildMs ?? 0}ms · 1st ${turn.firstTokenMs ?? 0}ms · total ${turn.totalMs ?? 0}ms${turn.error ? ' · error' : ''}`}
                  </text>
                ))}
              </div>
            ) : (
              <text testId="diagnostics-empty" style={{ fontSize: 11, fontFamily: FONT, color: C.tertiary }}>No timings read yet.</text>
            )}
          </SettingsRow>
          {stats ? (
            <SettingsRow label="Session usage" description="Counted from the persisted transcript." testId="settings-row-stats" column>
              <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <div testId="stats-messages" style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 7, backgroundColor: C.surfaceAlt }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{stats.totalMessages} messages</text></div>
                <div testId="stats-tokens" style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 7, backgroundColor: C.surfaceAlt }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{stats.tokens.total} tokens</text></div>
                <div testId="stats-tools" style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 7, backgroundColor: C.surfaceAlt }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{stats.toolCalls} tools</text></div>
                <div testId="stats-cost" style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 7, backgroundColor: C.surfaceAlt }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>${stats.cost.toFixed(4)}</text></div>
                {stats.contextPercent !== null ? <div testId="stats-context" style={{ paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, borderRadius: 7, backgroundColor: C.surfaceAlt }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{stats.contextPercent}% context</text></div> : null}
              </div>
            </SettingsRow>
          ) : (
            <SettingsRow label="Session usage" description="No completed session data yet." testId="settings-row-stats-empty" />
          )}
        </SettingsCard>
      ) : null}

      {section === 'developer' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <text style={{ fontSize: 13, fontWeight: 600, fontFamily: FONT, color: C.text, marginBottom: 8 }}>Workspace</text>
            <SettingsCard>
              <SettingsRow label="Diff, compaction, export" description="Inspect and reshape the current session." testId="settings-row-workspace" column>
                <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <SettingsAction label="Load diff" testId="load-diff" onClick={onGetDiff} />
                  <SettingsAction label="Compact" testId="compact-session" onClick={onCompact} />
                  <SettingsAction label="Snap compact" testId="snapcompact-session" onClick={onSnapcompact} />
                  <SettingsAction label="Export HTML" testId="export-session" onClick={onExport} />
                </div>
                {diffOutput ? <text testId="diff-output" style={{ fontSize: 11, lineHeight: 16, fontFamily: MONO_FONT, color: C.secondary, whiteSpace: 'normal' }}>{diffOutput}</text> : null}
                {exportedPath ? <text testId="export-path" style={{ fontSize: 11, fontFamily: MONO_FONT, color: C.tertiary, whiteSpace: 'normal' }}>{exportedPath}</text> : null}
                {compactionSummary ? <text testId="compaction-summary" style={{ fontSize: 11, lineHeight: 16, fontFamily: FONT, color: C.secondary, whiteSpace: 'normal' }}>{compactionSummary}</text> : null}
              </SettingsRow>
            </SettingsCard>
          </div>
          <div>
            <text style={{ fontSize: 13, fontWeight: 600, fontFamily: FONT, color: C.text, marginBottom: 8 }}>History</text>
            <SettingsCard>
              <SettingsRow label="Branch and restore" description="Fork, clone, or undo the current session." testId="settings-row-history" column>
                <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <SettingsAction label="Fork latest" testId="fork-latest" onClick={onForkLatest} />
                  <SettingsAction label="Clone session" testId="clone-session" onClick={onClone} />
                  <SettingsAction label="Undo latest" testId="undo-session" onClick={onUndo} />
                  <SettingsAction label="Load branch tree" testId="load-session-tree" onClick={onLoadTree} />
                </div>
                {branchMessage ? <text testId="branch-message" style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>{branchMessage}</text> : null}
              </SettingsRow>
              {tree.length ? <SettingsRow label="Branch tree" description="Pick a point in the session to fork from." testId="settings-row-tree"><SessionTreePanel nodes={tree} onFork={onForkEntry} /></SettingsRow> : null}
            </SettingsCard>
          </div>
          <div>
            <text style={{ fontSize: 13, fontWeight: 600, fontFamily: FONT, color: C.text, marginBottom: 8 }}>Direct bash</text>
            <SettingsCard>
              <SettingsRow label="Shell command" description="Runs in the engine and streams its output." testId="settings-row-bash" column>
                <input testId="bash-command" aria-label="Shell command" value={bashCommand} placeholder="pwd" onChange={(event) => onBashCommand(event.value ?? '')} onSubmit={onRunBash} theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }} style={{ minHeight: 32, paddingLeft: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border, backgroundColor: C.surfaceAlt, fontSize: 12, fontFamily: MONO_FONT, color: C.text }} />
                <SettingsAction label={bashRunning ? 'Running' : 'Run'} testId="run-bash" onClick={onRunBash} primary disabled={bashRunning} />
                {bashRunning ? <SettingsAction label="Cancel" testId="abort-bash" onClick={onAbortBash} /> : null}
                {bashOutput ? <text testId="bash-output" style={{ fontSize: 11, lineHeight: 16, fontFamily: MONO_FONT, color: C.secondary, whiteSpace: 'normal' }}>{bashOutput}</text> : null}
              </SettingsRow>
            </SettingsCard>
          </div>
        </div>
      ) : null}
        </div>
      </div>
    </div>
  )
}
function ToolActivityPanel({ activities }: { activities: ToolActivity[] }) {
  if (!activities.length) return null
  return (
    <div testId="tool-activity-panel" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginLeft: 24, marginRight: 24, marginBottom: 8 }}>
      {activities.map((activity) => (
        <div key={activity.id} testId={`tool-activity-${activity.id}`} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, padding: 7, borderRadius: 7, backgroundColor: C.surface }}>
          <text style={{ fontSize: 10, fontFamily: FONT, fontWeight: 700, color: activity.status === 'error' ? C.error : activity.status === 'done' ? C.success : C.accent }}>{activity.status.toUpperCase()}</text>
          <text style={{ fontSize: 11, fontFamily: FONT, color: C.text }}>{activity.name}</text>
          {activity.output ? <text style={{ flexGrow: 1, fontSize: 10, fontFamily: FONT, color: C.secondary, whiteSpace: 'normal' }}>{activity.output}</text> : null}
        </div>
      ))}
    </div>
  )
}

function InteractionCard({
  interaction,
  onAllow,
  onDeny,
  onAnswer,
}: {
  interaction: PendingInteraction
  onAllow: () => void
  onDeny: () => void
  onAnswer: (answer: string) => void
}) {
  const [answer, setAnswer] = useState('')
  const isApproval = interaction.kind === 'approval'

  return (
    <div
      testId={isApproval ? 'approval-card' : 'question-card'}
      style={{
        width: '100%',
        marginTop: 10,
        padding: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: isApproval ? C.accent : C.purple,
        backgroundColor: isApproval ? C.accentWash : C.purpleSoft,
      }}
    >
      <text style={{ fontSize: 12, fontWeight: 700, fontFamily: FONT, color: isApproval ? C.accent : C.purple }}>
        {isApproval ? 'Approval required' : 'Question'}
      </text>
      {isApproval ? (
        <>
          <text style={{ marginTop: 5, fontSize: 13, lineHeight: 19, fontFamily: FONT, color: C.text, whiteSpace: 'normal' }}>
            Allow this to run {interaction.toolName}?
          </text>
          <div style={{ display: 'flex', flexDirection: 'row', gap: 8, marginTop: 12 }}>
            <div
              testId="approval-allow"
              role="button"
              aria-label="Allow tool"
              tabIndex={0}
              onClick={onAllow}
              onKeyDown={(event) => runButtonKey(event, onAllow)}
              style={{ paddingTop: 7, paddingRight: 11, paddingBottom: 7, paddingLeft: 11, borderRadius: 8, backgroundColor: C.accent, cursor: 'pointer' }}
            >
              <text style={{ fontSize: 12, fontWeight: 700, fontFamily: FONT, color: C.onAccent }}>Allow</text>
            </div>
            <div
              testId="approval-deny"
              role="button"
              aria-label="Deny tool"
              tabIndex={0}
              onClick={onDeny}
              onKeyDown={(event) => runButtonKey(event, onDeny)}
              style={{ paddingTop: 7, paddingRight: 11, paddingBottom: 7, paddingLeft: 11, borderRadius: 8, borderWidth: 1, borderColor: C.borderStrong, cursor: 'pointer' }}
            >
              <text style={{ fontSize: 12, fontFamily: FONT, color: C.secondary }}>Deny</text>
            </div>
          </div>
        </>
      ) : (
        <>
          <text style={{ marginTop: 5, fontSize: 13, lineHeight: 19, fontFamily: FONT, color: C.text, whiteSpace: 'normal' }}>
            {interaction.question}
          </text>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input
              testId="question-input"
              aria-label="Answer"
              value={answer}
              placeholder="Type your answer..."
              onChange={(event) => setAnswer(event.value ?? '')}
              onSubmit={() => answer.trim() && onAnswer(answer.trim())}
              theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }}
              style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontFamily: FONT, color: C.text }}
            />
            <div
              testId="answer-question"
              role="button"
              aria-label="Send answer"
              tabIndex={0}
              onClick={() => answer.trim() && onAnswer(answer.trim())}
              onKeyDown={(event) => runButtonKey(event, () => answer.trim() && onAnswer(answer.trim()))}
              style={{ paddingTop: 7, paddingRight: 11, paddingBottom: 7, paddingLeft: 11, borderRadius: 8, backgroundColor: answer.trim() ? C.accent : C.surfaceAlt, cursor: answer.trim() ? 'pointer' : 'default' }}
            >
              <text style={{ fontSize: 12, fontWeight: 700, fontFamily: FONT, color: answer.trim() ? C.onAccent : C.tertiary }}>Send</text>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Rows are one line, so a long description has to be cut in JS. The platform
// clips a nowrap text at the element edge with no ellipsis, which reads as a
// broken layout rather than a shortened one.
const DETAIL_MAX_CHARS = 88

function truncateDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= DETAIL_MAX_CHARS ? flat : `${flat.slice(0, DETAIL_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * Slash-command dock.
 *
 * Every command dispatches as `/name` typed into the composer, so that is where
 * they are discovered: right where they are used, filtered by what you have
 * typed. This replaced a command palette, which was a second path to the same
 * actions and therefore had no reason to exist.
 */
function CommandDock({
  commands,
  onPick,
}: {
  commands: CommandSummary[]
  onPick: (command: CommandSummary) => void
}) {
  const [active, setActive] = useState(0)
  const visible = commands.slice(0, 8)

  useEffect(() => { setActive(0) }, [commands])

  const onKeyDown = (event: { key?: string }) => {
    if (event.key === 'arrowdown' || event.key === 'down') {
      setActive((i) => Math.min(i + 1, visible.length - 1))
      return
    }
    if (event.key === 'arrowup' || event.key === 'up') {
      setActive((i) => Math.max(i - 1, 0))
      return
    }
    if (event.key === 'enter' || event.key === 'tab') {
      const picked = visible[active]
      if (picked) onPick(picked)
      return
    }
    if (event.key === 'escape') { onPick(visible[active] ?? commands[0]) }
  }

  return (
    <div
      testId="command-dock"
      style={{
        width: '100%',
        marginBottom: 6,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: C.border,
        backgroundColor: C.surface,
        overflow: 'hidden',
      }}
    >
      {visible.map((command, index) => (
        <div
          key={command.name}
          testId={`dock-${command.name}`}
          role="button"
          aria-label={`Insert ${command.name}`}
          tabIndex={0}
          onClick={() => onPick(command)}
          onKeyDown={(event) => runButtonKey(event, () => onPick(command))}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'baseline',
            gap: 8,
            minHeight: 30,
            paddingLeft: 10,
            paddingRight: 10,
            backgroundColor: index === active ? C.raised : 'transparent',
            cursor: 'pointer',
            hover: { backgroundColor: C.surfaceAlt },
          }}
        >
          <text style={{ width: 150, flexShrink: 0, fontSize: 12, fontFamily: FONT, color: C.accent, whiteSpace: 'nowrap' }}>
            {`/${command.name}`}
          </text>
          <text style={{ flexGrow: 1, minWidth: 0, fontSize: 11, fontFamily: FONT, color: C.tertiary, whiteSpace: 'nowrap' }}>
            {truncateDetail(command.description)}
          </text>
        </div>
      ))}
      <div
        onKeyDown={onKeyDown}
        style={{ paddingLeft: 10, paddingTop: 5, paddingBottom: 5, borderTopWidth: 1, borderColor: C.border }}
      >
        <text style={{ fontSize: 10, fontFamily: FONT, color: C.ghost }}>
          Up and down to move · Tab or Return to insert · Esc to dismiss
        </text>
      </div>
    </div>
  )
}

function Composer({
  draft,
  busy,
  onChange,
  onSubmit,
  onStop,
  onSteer,
  onFollowUp,
  mode,
  willStopAgent,
  runningAgentName,
}: {
  draft: string
  busy: boolean
  mode: AgentClient['mode']
  willStopAgent: boolean
  runningAgentName: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onStop: () => void
  onSteer: () => void
  onFollowUp: () => void
}) {
  const canSend = draft.trim().length > 0
  const action = busy ? onStop : () => onSubmit(draft)

  return (
    <div
      style={{
        width: '100%',
        maxWidth: CONTENT_MAX_WIDTH,
        minWidth: 0,
        alignSelf: 'center',
        flexShrink: 0,
        paddingTop: 12,
        paddingBottom: 16,
        paddingLeft: 16,
        paddingRight: 16,
      }}
    >
      {willStopAgent ? (
        <div
          testId="will-stop-agent"
          role="status"
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            paddingLeft: 12,
            paddingRight: 12,
            paddingTop: 8,
            paddingBottom: 8,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: C.warning,
            backgroundColor: C.surfaceAlt,
          }}
        >
          <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.warning }} />
          <text style={{ flexGrow: 1, fontSize: 11.5, lineHeight: 16, fontFamily: FONT, color: C.secondary, whiteSpace: 'normal' }}>
            {`Sending here will stop "${runningAgentName}". One agent runs at a time.`}
          </text>
        </div>
      ) : null}
      <div
        style={{
          minHeight: 52,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingLeft: 16,
          paddingRight: 8,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: C.border,
          backgroundColor: C.raised,
          boxShadow: ELEV.overlay,
        }}
      >
        <input
          testId="chat-input"
          aria-label="Message"
          value={draft}
          placeholder="Ask anything..."
          autoFocus
          onChange={(event) => onChange(event.value ?? '')}
          onSubmit={() => onSubmit(draft)}
          theme={{ caret: C.accent, text: C.text, textMuted: C.tertiary }}
          style={{
            flexGrow: 1,
            minWidth: 0,
            fontSize: 14,
            fontFamily: FONT,
            color: C.text,
          }}
        />
        <div
          testId={busy ? 'stop-message' : 'send-message'}
          role="button"
          aria-label={busy ? 'Stop' : 'Send message'}
          tabIndex={0}
          onClick={action}
          onKeyDown={(event) => runButtonKey(event, action)}
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: busy ? C.error : canSend ? C.accent : C.raisedStrong,
            cursor: busy || canSend ? 'pointer' : 'default',
            opacity: busy || canSend ? 1 : 0.5,
            hover: busy ? { backgroundColor: C.error } : canSend ? { backgroundColor: C.accentHover } : undefined,
            active: busy ? { backgroundColor: C.error, opacity: 0.85 } : canSend ? { backgroundColor: C.accentPressed, opacity: 0.9 } : undefined,
          }}
        >
          {busy ? (
            <text style={{ fontSize: 13, fontFamily: FONT, color: C.text }}>■</text>
          ) : (
            <Icon name="arrowUp" size={17} color={canSend ? C.onAccent : C.tertiary} />
          )}
        </div>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: 4,
          paddingRight: 4,
          marginTop: 7,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {busy ? <div testId="steer-message" role="button" aria-label="Steer current turn" tabIndex={0} onClick={onSteer} onKeyDown={(event) => runButtonKey(event, onSteer)} style={{ paddingTop: 4, paddingRight: 7, paddingBottom: 4, paddingLeft: 7, borderRadius: 6, backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border, cursor: 'pointer', active: { backgroundColor: C.raisedStrong } }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>Steer</text></div> : null}
          {busy ? <div testId="follow-up-message" role="button" aria-label="Queue follow-up" tabIndex={0} onClick={onFollowUp} onKeyDown={(event) => runButtonKey(event, onFollowUp)} style={{ paddingTop: 4, paddingRight: 7, paddingBottom: 4, paddingLeft: 7, borderRadius: 6, backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border, cursor: 'pointer', active: { backgroundColor: C.raisedStrong } }}><text style={{ fontSize: 11, fontFamily: FONT, color: C.secondary }}>Follow up</text></div> : null}
          <text style={{ fontSize: 11, fontFamily: FONT, color: C.ghost }}>
            {mode === 'engine' ? 'Engine' : 'Local preview'}
          </text>
        </div>
      </div>
    </div>
  )
}

function createAgentReply(prompt: string): string {
  const normalized = prompt.toLowerCase()

  if (normalized.includes('plan') || normalized.includes('project')) {
    return "Let's make a small plan. First, name the outcome, then list the constraints, and finish with the first step you can do today. Share the goal and I'll turn it into a checklist."
  }

  if (normalized.includes('explain') || normalized.includes('concept')) {
    return "Start with the core idea in one sentence, then work through a concrete example. Tell me the topic and how much background you have, and I'll keep the explanation focused."
  }

  if (normalized.includes('debug') || normalized.includes('bug') || normalized.includes('error')) {
    return "Let's debug it in a loop: reproduce the failure, capture the exact error, and narrow the cause by changing one thing at a time. Paste the error and the relevant code."
  }

  if (normalized === 'hi' || normalized.startsWith('hello') || normalized.startsWith('hey')) {
    return "Hey. Tell me what you're working on, and I'll help you find the next useful move."
  }

  const topic = prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt
  return `I’m following. For "${topic}", I’d start by clarifying the outcome and the smallest next step. What would you like to explore first?`
}

export function ChatApp({ client: providedClient }: { client?: AgentClient } = {}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [commands, setCommands] = useState<CommandSummary[]>([])
  // The dock shows while the draft is a slash query, filtered by what is typed.
  const slashQuery = draft.startsWith('/') && !draft.includes(' ') ? draft.slice(1).toLowerCase() : null
  const dockCommands = slashQuery === null
    ? []
    : commands.filter((command) => command.name.toLowerCase().includes(slashQuery))

  const [collapsed, setCollapsed] = useState(false)
  const [busy, setBusy] = useState(false)
  // Running agents are tracked per session so the sidebar can show more than
  // one working agent, and a non-session draft uses DRAFT_SESSION_KEY.
  const [running, setRunning] = useState<Record<string, boolean>>({})
  // Older transcript pages are fetched on demand rather than all at once, so
  // opening a long session costs one page instead of the whole conversation.
  const [olderCursor, setOlderCursor] = useState('')
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [expandedSpaces, setExpandedSpaces] = useState<Record<string, boolean>>({})
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = readStoredSidebarWidth()
    return stored === null ? SIDEBAR_WIDTH : Math.max(SIDEBAR_MIN_WIDTH, Math.min(stored, SIDEBAR_MAX_WIDTH))
  })
  // Static cap: polling window size re-renders the whole chat 10x/sec, which is
  // not worth the responsive clamp for a chat surface.
  const sidebarMaxWidth = SIDEBAR_MAX_WIDTH
  // The session whose transcript is currently on screen. This can differ from
  // the engine's active (running) session, because viewing is passive.
  const [viewingSessionPath, setViewingSessionPath] = useState<string | null>(null)
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [queueStatus, setQueueStatus] = useState('')
  const [compactionStatus, setCompactionStatus] = useState('')
  const [turnStatus, setTurnStatus] = useState('')
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null)
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([])
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('session')
  const [memoryState, setMemoryState] = useState<MemorySnapshot>({ entries: [], used: 0, max: 2200, path: '' })
  const [skills, setSkills] = useState<SkillSummary[]>([])
  // A scope names where a decision applies. "Everywhere" is the global layer;
  // anything else is one project by path. There is deliberately no "this
  // project", because the shell can hold sessions from several at once and two
  // agents can be running in two of them.
  const [skillScope, setSkillScope] = useState<string>(SKILL_SCOPE_GLOBAL)
  const [skillProjects, setSkillProjects] = useState<SkillProject[]>([])
  const [skillsError, setSkillsError] = useState('')

  // Only the skills that can apply to the selected scope. A project skill
  // belongs to one project, so offering it anywhere else would be a choice that
  // silently does nothing.
  const visibleSkills = useMemo(
    () => skills.filter((skill) => skill.project === '' || skill.project === skillScope),
    [skills, skillScope],
  )
  const [skillPending, setSkillPending] = useState(false)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [memoryEditing, setMemoryEditing] = useState<{ index: number } | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const [model, setModel] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [provider, setProvider] = useState('')
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [approvalMode, setApprovalMode] = useState<'auto' | 'ask'>('auto')
  const [autoCompaction, setAutoCompaction] = useState(false)
  const [autoRetry, setAutoRetry] = useState(false)
  const [steeringMode, setSteeringMode] = useState('one-at-a-time')
  const [followUpMode, setFollowUpMode] = useState('one-at-a-time')
  const [maxTokens, setMaxTokens] = useState(0)
  const [reasoning, setReasoning] = useState('')
  const [reasoningLevels, setReasoningLevels] = useState<string[]>([])
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [exportedPath, setExportedPath] = useState('')
  const [compactionSummary, setCompactionSummary] = useState('')
  const [branchMessage, setBranchMessage] = useState('')
  const [loginProvider, setLoginProvider] = useState<'opencode-go' | 'opencode-zen'>('opencode-go')
  const [loginKey, setLoginKey] = useState('')
  const [loginStatus, setLoginStatus] = useState('')
  const [sessionPath, setSessionPath] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [connectionStatus, setConnectionStatus] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [diagnosticsStatus, setDiagnosticsStatus] = useState('')
  const [runtimeState, setRuntimeState] = useState('')
  const [tree, setTree] = useState<SessionTreeNode[]>([])
  const [bashCommand, setBashCommand] = useState('')
  const [bashOutput, setBashOutput] = useState('')
  const [bashRunning, setBashRunning] = useState(false)
  const [diffOutput, setDiffOutput] = useState('')
  const nextId = useRef(0)
  const client = useMemo(
    () => providedClient ?? createLocalAgentClient(createAgentReply),
    [providedClient],
  )

  useEffect(() => () => client.close(), [client])

  // The engine's command list is static for a session, so it is fetched once.
  useEffect(() => {
    let cancelled = false
    void client.getCommands().then((list) => {
      if (!cancelled) setCommands(mergeCommands(BUILTIN_COMMANDS, list))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [client])

  useEffect(() => {
    if (client.mode !== 'engine') return
    let mounted = true
    void client.listSessions().then((items) => {
      if (mounted) setSessions(items)
    }).catch(() => {})
    void client.getSessionStats().then((value) => {
      if (mounted) setSessionStats(value)
    }).catch(() => {})
    void client.getTranscriptPage('', TRANSCRIPT_PAGE).then((page) => {
      if (!mounted) return
      setOlderCursor(page.earliestId)
      setHasOlder(page.hasMore)
      if (page.messages.length) setMessages((current) => (current.length ? current : page.messages))
    }).catch(() => {})
    void Promise.all([client.getState(), client.getProviders(), client.getModels(), client.getThinkingLevels()]).then(([state, providerList, modelList, levels]) => {
      if (!mounted) return
      setModel(state.model)
      setProvider(state.provider)
      setApprovalMode(state.approvalMode === 'ask' ? 'ask' : 'auto')
      setAutoCompaction(state.autoCompaction)
      setAutoRetry(state.autoRetry)
      setSteeringMode(state.steeringMode)
      setFollowUpMode(state.followUpMode)
      setMaxTokens(state.maxTokens)
      setRuntimeState(state.state)
      setReasoning(state.thinkingLevel)
      setProviders(providerList)
      setModels(modelList)
      setReasoningLevels(levels)
    }).catch(() => {})
    return () => {
      mounted = false
    }
  }, [client])

  const currentTitle = useMemo(() => {
    if (activeSession?.name) return activeSession.name
    const firstUserMessage = messages.find((message) => message.role === 'user')
    if (!firstUserMessage) return 'New conversation'

    const content = firstUserMessage.content.trim()
    return content.length > 28 ? `${content.slice(0, 28)}...` : content
  }, [activeSession, messages])

  const appendRuntimeError = (message: string) => {
    const id = nextId.current + 1
    nextId.current = id
    setMessages((current) => [...current, { id: `m${id}`, role: 'assistant', content: `Engine error: ${message}` }])
  }

  const resolveApproval = (approved: boolean) => {
    const interaction = pendingInteraction
    if (!interaction || interaction.kind !== 'approval') return
    setPendingInteraction(null)
    void client.answerApproval(interaction.toolCallId, approved).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    })
  }

  const resolveQuestion = (answer: string) => {
    const interaction = pendingInteraction
    if (!interaction || interaction.kind !== 'question' || !answer.trim()) return
    setPendingInteraction(null)
    void client.answerQuestion(interaction.questionId, answer.trim()).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    })
  }

  const loadDiff = () => {
    void client.getDiff().then(setDiffOutput).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const abortBash = () => {
    void client.abortBash().catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const runBash = () => {
    const command = bashCommand.trim()
    if (!command || bashRunning) return
    setBashRunning(true)
    setBashOutput('')
    void client.bash(command, (delta) => setBashOutput((current) => current + delta)).then((result) => {
      setBashOutput(result.output || `exit ${result.exitCode}`)
      setBashRunning(false)
    }).catch((error: unknown) => {
      setBashOutput(error instanceof Error ? error.message : String(error))
      setBashRunning(false)
    })
  }

  const loadTree = () => {
    void client.getTree().then(setTree).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const captureDiagnostics = () => {
    void client
      .getDiagnostics()
      .then((value) => setDiagnostics(value))
      .catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const saveDiagnostics = () => {
    void client
      .writeDiagnostics()
      .then((value) => {
        if (!value) {
          setDiagnosticsStatus('The engine wrote no report')
          return
        }
        setDiagnosticsStatus(`Saved to ${value.path}`)
      })
      .catch((error: unknown) => setDiagnosticsStatus(error instanceof Error ? error.message : String(error)))
  }

  const pingEngine = () => {
    void client.ping().then((ok) => setConnectionStatus(ok ? 'Engine connected' : 'Engine did not respond')).catch((error: unknown) => setConnectionStatus(error instanceof Error ? error.message : String(error)))
  }

  const loadOlderMessages = () => {
    if (!hasOlder || loadingOlder || !olderCursor) return
    setLoadingOlder(true)
    void client
      .getTranscriptPage(olderCursor, TRANSCRIPT_PAGE)
      .then((page) => {
        // Older entries belong above what is on screen, so they are prepended
        // rather than appended, and the cursor moves further back.
        setMessages((current) => [...page.messages, ...current])
        setOlderCursor(page.earliestId)
        setHasOlder(page.hasMore)
      })
      .catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoadingOlder(false))
  }

  const switchSessionByPath = () => {
    if (!sessionPath.trim()) return
    void client.switchSession(sessionPath.trim()).then(async (session) => {
      if (!session) return
      setActiveSession(session)
      setSessionName(session.name)
      const page = await client.getTranscriptPage('', TRANSCRIPT_PAGE)
      setMessages(page.messages)
      setOlderCursor(page.earliestId)
      setHasOlder(page.hasMore)
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const renameSession = () => {
    if (!sessionName.trim()) return
    void client.setSessionName(sessionName.trim()).then(() => {
      setSessions((current) => current.map((session) => session.path === activeSession?.path ? { ...session, name: sessionName.trim() } : session))
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const saveLogin = () => {
    if (!loginKey.trim()) {
      setLoginStatus('Enter an API key first.')
      return
    }
    void client.setApiKey(loginProvider, loginKey.trim()).then(() => {
      setLoginKey('')
      setLoginStatus(`Saved ${loginProvider} credentials.`)
    }).catch((error: unknown) => setLoginStatus(error instanceof Error ? error.message : String(error)))
  }

  const undoSession = () => {
    void client.undo().then(async (path) => {
      if (!path) {
        setBranchMessage('There is no user turn to undo.')
        return
      }
      await client.switchSession(path)
      const transcript = await client.getTranscript()
      setMessages(transcript)
      setTree([])
      setBranchMessage('Undid the latest user turn.')
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const cloneSession = () => {
    void client.cloneSession().then(async (path) => {
      if (!path) {
        setBranchMessage('The session clone could not be created.')
        return
      }
      await client.switchSession(path)
      const transcript = await client.getTranscript()
      setMessages(transcript)
      setBranchMessage('Activated a cloned session.')
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const forkEntry = (entryId: string) => {
    void client.fork(entryId).then(async (path) => {
      if (!path) {
        setBranchMessage('The fork could not be created.')
        return
      }
      await client.switchSession(path)
      const transcript = await client.getTranscript()
      setMessages(transcript)
      setTree([])
      setBranchMessage('Activated a forked session.')
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const forkLatest = () => {
    void client.getForkMessages().then(async (candidates) => {
      const latest = candidates[candidates.length - 1]
      if (!latest) {
        setBranchMessage('No user message is available to fork.')
        return
      }
      const path = await client.fork(latest.entryId)
      if (!path) {
        setBranchMessage('The fork could not be created.')
        return
      }
      await client.switchSession(path)
      const transcript = await client.getTranscript()
      setMessages(transcript)
      setBranchMessage('Activated a forked session.')
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const queueMessage = (kind: 'steer' | 'followUp') => {
    const content = draft.trim()
    if (!content || !busy) return
    setDraft('')
    const label = kind === 'steer' ? 'Steer' : 'Follow up'
    setMessages((current) => [...current, { id: `m${nextId.current + 1}`, role: 'user', content: `${label}: ${content}` }])
    nextId.current += 1
    const request = kind === 'steer' ? client.steer(content) : client.followUp(content)
    void request.catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  // The engine runs one session at a time. If an agent is running in a
  // different session than the one on screen, sending here will switch the
  // engine (stopping that agent) — the composer surfaces this explicitly.
  const runningElsewhere = Object.keys(running).find(
    (path) => path !== DRAFT_SESSION_KEY && path !== viewingSessionPath,
  )
  const willStopAgent = runningElsewhere !== undefined

  // Stopping is an explicit action: reset the UI immediately rather than
  // waiting for a settled event that may never arrive.
  const stopCurrentAgent = () => {
    client.stop()
    setBusy(false)
    setTurnStatus('')
    setPendingInteraction(null)
    setRunning((current) => {
      const key = runningElsewhere ?? viewingSessionPath ?? DRAFT_SESSION_KEY
      return omitKey(current, key)
    })
  }

  const sendMessage = (value: string) => {
    const content = value.trim()
    if (!content || busy) return

    const targetPath = viewingSessionPath

    const userId = nextId.current + 1
    const assistantId = userId + 1
    nextId.current = assistantId
    const assistantKey = `m${assistantId}`

    setMessages((current) => [
      ...current,
      { id: `m${userId}`, role: 'user', content },
      { id: assistantKey, role: 'assistant', content: '' },
    ])
    setDraft('')
    setBusy(true)
    // Sending into an existing session keeps that path as the run key. A draft
    // has no path yet, so it starts under the draft key and is re-keyed by
    // createSessionForDraft once the engine hands one back.
    const runKey = { current: targetPath ?? DRAFT_SESSION_KEY }
    setRunning((current) => ({ ...current, [runKey.current]: true }))

    const dispatch = () => client.send(content, (event) => {
      if (event.kind === 'started') setTurnStatus('Turn started')
      if (event.kind === 'turn_end') setTurnStatus('Turn ended')
      if (event.kind === 'agent_end') setTurnStatus('Agent ended')
      if (event.kind === 'text_delta') {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantKey
              ? { ...message, content: message.content + event.text }
              : message,
          ),
        )
      }
      if (event.kind === 'compaction_start') {
        setCompactionStatus(`${event.reason} in progress`)
      }
      if (event.kind === 'compaction_end') {
        setCompactionStatus(event.summary ? 'Compaction complete' : `${event.reason} complete`)
      }
      if (event.kind === 'queue_update') {
        setQueueStatus(`${event.steering.length} steering · ${event.followUp.length} follow-up`)
      }
      if (event.kind === 'retry_start') {
        setMessages((current) => current.map((message) => message.id === assistantKey ? { ...message, content: `${message.content}\n[retry ${event.attempt}/${event.maxAttempts}] waiting ${event.delayMs}ms…\n` } : message))
      }
      if (event.kind === 'retry_end') {
        setMessages((current) => current.map((message) => message.id === assistantKey ? { ...message, content: `${message.content}[retry ${event.success ? 'succeeded' : 'ended'}]\n` } : message))
      }
      if (event.kind === 'tool_start') {
        setToolActivities((current) => [...current, { id: event.toolCallId, name: event.toolName, status: 'running', output: '' }])
      }
      if (event.kind === 'tool_end') {
        setToolActivities((current) => current.map((activity) => activity.id === event.toolCallId ? { ...activity, status: event.isError ? 'error' : 'done', output: event.output.slice(0, 240) } : activity))
      }
      if (event.kind === 'approval') {
        setPendingInteraction({ kind: 'approval', toolCallId: event.toolCallId, toolName: event.toolName })
      }
      if (event.kind === 'question') {
        setPendingInteraction({ kind: 'question', questionId: event.questionId, question: event.question })
      }
      if (event.kind === 'session_switched') {
        // The engine resumed a session the agent chose. Follow it: load that
        // transcript and point the UI at it, rather than leaving a transcript
        // on screen that the engine has already left.
        const cwd = event.cwd || sessions.find((item) => item.path === event.path)?.cwd || ''
        const summary: SessionSummary = {
          id: event.path,
          path: event.path,
          cwd,
          name: event.name || 'Session',
          updatedAt: Date.now(),
        }
        setActiveSession(summary)
        setViewingSessionPath(event.path)
        setRunning((current) => omitKey(current, DRAFT_SESSION_KEY))
        setSessions((current) => [summary, ...current.filter((item) => item.path !== event.path)])
        setLoadingTranscript(true)
        void client.getTranscript(event.path).then((transcript) => {
          setMessages(transcript)
          setDraft('')
          setLoadingTranscript(false)
        }).catch(() => setLoadingTranscript(false))
        return
      }
      if (event.kind === 'error') {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantKey ? { ...message, content: event.message } : message,
          ),
        )
      }
      if (event.kind === 'settled') {
        setTurnStatus('')
        setPendingInteraction(null)
        setBusy(false)
        setRunning((current) => omitKey(current, runKey.current))
      }
    })
    // A draft chat becomes a session on its first message. The real path comes
    // back only now, so the run is re-keyed to it and the agent row and session
    // list reflect what actually exists. Only this path awaits; sending into an
    // existing session, and local preview, dispatch without an extra tick.
    const createSessionForDraft = async (): Promise<void> => {
      const created = await client.newSession()
      if (!created) return
      setActiveSession(created)
      setViewingSessionPath(created.path)
      setSessions((current) => [created, ...current.filter((item) => item.path !== created.path)])
      runKey.current = created.path
      setRunning((current) => {
        const next = omitKey(current, DRAFT_SESSION_KEY)
        return { ...next, [created.path]: true }
      })
    }

    const promise = targetPath
      ? client.switchSession(targetPath).then(dispatch)
      : client.mode === 'engine'
        ? createSessionForDraft().then(dispatch)
        : dispatch()
    void promise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantKey ? { ...item, content: `Engine error: ${message}` } : item,
        ),
      )
      setBusy(false)
      setRunning((current) => omitKey(current, runKey.current))
    })
  }

  const changeProvider = (next: string) => {
    setProvider(next)
    void client.setProvider(next).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    })
  }

  const changeApprovalMode = (next: 'auto' | 'ask') => {
    setApprovalMode(next)
    void client.setApprovalMode(next).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    })
  }

  const changeAutoCompaction = (enabled: boolean) => {
    setAutoCompaction(enabled)
    void client.setAutoCompaction(enabled).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const changeAutoRetry = (enabled: boolean) => {
    setAutoRetry(enabled)
    void client.setAutoRetry(enabled).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const changeMaxTokens = (value: string) => {
    const parsed = Number.parseInt(value, 10)
    setMaxTokens(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0)
  }

  const saveMaxTokens = () => {
    void client.setMaxTokens(maxTokens).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const changeSteeringMode = (mode: string) => {
    setSteeringMode(mode)
    void client.setSteeringMode(mode).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const changeFollowUpMode = (mode: string) => {
    setFollowUpMode(mode)
    void client.setFollowUpMode(mode).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  const changeModel = (next: string) => {
    setModel(next)
    void client.setModel(next).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    })
  }

  const changeReasoning = (next: string) => {
    setReasoning(next)
    void client.setThinkingLevel(next).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    })
  }

  // Opening a chat is not creating one. The engine writes a session file the
  // moment new_session is called, so doing it here left an empty session behind
  // for every click. The session is created by the first message instead.
  const appendAssistantText = (text: string) => {
    setMessages((current) => [...current, { id: `m${nextId.current + 1}`, role: 'assistant', content: text }])
  }

  // Most commands dispatch as `/name` in the composer, which is exactly what
  // the dock inserts, so picking one takes the same path a typed command does.
  // A few are answered by the shell rather than by a turn.
  const runCommand = (command: CommandSummary) => {
    if (command.name === 'help') { appendAssistantText(HELP_TEXT); return }
    if (command.name === 'version') { appendAssistantText(`Escape ${VERSION}`); return }
    if (command.name === 'last-response') {
      void client.getLastAssistantText().then(appendAssistantText)
        .catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
      return
    }
    if (command.name === 'recap') {
      void client.recap().then(appendAssistantText)
        .catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
      return
    }
    const prompt = command.name === 'review' ? REVIEW_PROMPT : `/${command.name}`
    void client.send(prompt, (event) => {
      if (event.kind === 'error') appendRuntimeError(event.message)
    }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
  }

  // Cmd shortcuts, per the macOS HIG. Escape is layered: it closes the most
  // recent thing rather than stopping an agent, so a stray Esc while reading
  // settings does not kill a run.
  const closeTopLayer = () => {
    if (settingsOpen) { setSettingsOpen(false); return true }
    return false
  }

  const runWindowCommand = (command: WindowCommand) => {
    switch (command) {
      case 'new-chat':
        startNewChat()
        return
      case 'open-settings':
        setSettingsOpen(true)
        return
      case 'toggle-sidebar':
        setCollapsed((value) => !value)
        return
      case 'collapse-sidebar':
        setCollapsed(true)
        return
      case 'expand-sidebar':
        setCollapsed(false)
        return
      case 'close-top':
        closeTopLayer()
        return
      case 'stop-agent':
        if (closeTopLayer()) return
        if (busy) { stopCurrentAgent(); return }
        setViewingSessionPath(null)
        return
      default: {
        const index = Number(command.slice('settings-section-'.length)) - 1
        if (Number.isInteger(index) && SETTINGS_SECTIONS[index]) {
          setSettingsOpen(true)
          setSettingsSection(SETTINGS_SECTIONS[index].id)
        }
      }
    }
  }

  useEffect(() => {
    windowKeys.current = runWindowCommand
    return () => { windowKeys.current = null }
  })

  // Memory and skills are engine state, so they are read when settings opens
  // rather than kept live. Memory changes when the agent writes, which is
  // mid-turn, and skills change when the user toggles one here.
  useEffect(() => {
    if (!settingsOpen) return
    let cancelled = false
    void client.getMemory().then((snapshot) => {
      if (!cancelled) setMemoryState(snapshot)
    }).catch(() => {})
    void client.listSkills().then((result) => {
      if (cancelled) return
      setSkills([...result.skills].sort((a, b) => a.name.localeCompare(b.name)))
      setSkillProjects(result.projects)
      setSkillsError('')
    }).catch((error: unknown) => {
      // An engine that cannot answer is not the same as a machine with no
      // skills, and saying "none found" would be a lie.
      if (cancelled) return
      setSkills([])
      setSkillsError(error instanceof Error ? error.message : String(error))
    })
    return () => { cancelled = true }
  }, [settingsOpen, client])

  // The switch is optimistic so the row reacts on press. The engine answers
  // whether it had to defer the change to the end of the turn.
  const applySkillToggle = async (skill: SkillSummary, enabled: boolean) => {
    // Optimistic in the scope being edited, and the effective state follows it.
    setSkills((current) => current.map((s) => {
      if (s.path !== skill.path) return s
      const next = { ...s }
      if (skillScope === SKILL_SCOPE_GLOBAL) {
        next.globalEnabled = enabled
        next.overrides = s.overrides.filter((o) => o.project !== skillScope)
        next.enabled = s.overrides.some((o) => o.project === skillScope) ? enabled : s.enabled
      } else {
        const rest = s.overrides.filter((o) => o.project !== skillScope)
        next.overrides = [...rest, { project: skillScope, enabled }]
        next.enabled = enabled
      }
      return next
    }))
    try {
      const result = await client.setSkillEnabled(
        skill.path,
        enabled,
        skillScope === SKILL_SCOPE_GLOBAL ? 'global' : 'project',
        skillScope === SKILL_SCOPE_GLOBAL ? undefined : skillScope,
      )
      setSkillPending(result.pending)
    } catch (error) {
      // Put the row back the way the engine still sees it.
      setSkills((current) => current.map((s) => (s.path === skill.path ? { ...skill } : s)))
      setMemoryError(error instanceof Error ? error.message : String(error))
    }
  }

  const startMemoryEdit = (index: number, text: string) => {
    setMemoryEditing({ index })
    setMemoryDraft(text)
    setMemoryError('')
  }

  const failMemory = (error: unknown) => {
    setMemoryError(error instanceof Error ? error.message : String(error))
  }

  const submitMemory = async () => {
    const text = memoryDraft.trim()
    if (!text) return
    try {
      const next = memoryEditing
        ? await client.replaceMemory(memoryEditing.index, text)
        : await client.addMemory(text)
      setMemoryState(next)
      setMemoryDraft('')
      setMemoryEditing(null)
      setMemoryError('')
    } catch (error) {
      failMemory(error)
    }
  }

  const applyMemoryRemove = async (index: number) => {
    try {
      setMemoryState(await client.removeMemory(index))
      setMemoryError('')
    } catch (error) {
      failMemory(error)
    }
  }

  const startNewChat = () => {
    setMessages([])
    setDraft('')
    setPendingInteraction(null)
    setActiveSession(null)
    setViewingSessionPath(null)
  }

  // Selecting a session is a passive VIEW: it loads that session's transcript by
  // path and does not touch the engine's active session, so an agent running in
  // another session keeps running.
  const selectSession = (session: SessionSummary) => {
    setActiveSession(session)
    setViewingSessionPath(session.path)
    setLoadingTranscript(true)
    void client.getTranscript(session.path).then((transcript) => {
      setMessages(transcript)
      setDraft('')
      setPendingInteraction(null)
    }).catch((error: unknown) => {
      appendRuntimeError(error instanceof Error ? error.message : String(error))
    }).finally(() => setLoadingTranscript(false))
  }

  const spaces = useMemo(() => {
    const byCwd = new Map<string, SessionSummary[]>()
    for (const session of sessions) {
      const list = byCwd.get(session.cwd) ?? []
      list.push(session)
      byCwd.set(session.cwd, list)
    }
    return Array.from(byCwd.entries()).map(([path, list]) => ({ id: path, name: basenameOf(path), path, sessions: list }))
  }, [sessions])

  const { activeSpaceName, activeSpacePath } = useMemo(() => {
    const path = viewingSessionPath ?? activeSession?.path
    if (!path) return { activeSpaceName: '', activeSpacePath: '' }
    const session = sessions.find((item) => item.path === path)
    return session
      ? { activeSpaceName: basenameOf(session.cwd), activeSpacePath: session.cwd }
      : { activeSpaceName: '', activeSpacePath: '' }
  }, [viewingSessionPath, activeSession, sessions])

  const agents = useMemo<RunningAgent[]>(
    () =>
      Object.keys(running)
        .filter((path) => path !== DRAFT_SESSION_KEY)
        .map((path) => ({
          path,
          name: sessions.find((item) => item.path === path)?.name || 'Agent',
        })),
    [running, sessions],
  )

  return (
    <div
      testId="app-root"
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        backgroundColor: C.canvas,
      }}
    >
      <motion.div
        initial={false}
        animate={{ width: collapsed || settingsOpen ? 0 : sidebarWidth }}
        transition={{ duration: resizingSidebar ? 0 : SIDEBAR_TRANSITION_SECONDS, ease: 'easeOut' }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          height: '100%',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <Sidebar
          currentTitle={currentTitle}
          hasMessages={messages.length > 0}
          spaces={spaces}
          agents={agents}
          expanded={expandedSpaces}
          activeSessionPath={activeSession?.path ?? null}
          now={Date.now()}
          onToggleSpace={(id) => setExpandedSpaces((current) => ({ ...current, [id]: current[id] === false }))}
          onNewChat={startNewChat}
          onSelectSession={selectSession}
          onOpenAgent={(path) => {
            const session = sessions.find((item) => item.path === path)
            if (session) selectSession(session)
          }}
          onStopAgent={(session) => {
            // Keep the UI and engine in sync: switch (and load) the agent's
            // session before stopping, so the next message targets what is shown.
            void client.switchSession(session.path).then(async () => {
              const transcript = await client.getTranscript()
              setActiveSession(session)
              setMessages(transcript)
              setPendingInteraction(null)
              client.stop()
              setRunning((current) => omitKey(current, session.path))
            }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
          }}
          onSettings={() => setSettingsOpen((open) => !open)}
          width={sidebarWidth}
          maxWidth={sidebarMaxWidth}
          onResize={setSidebarWidth}
          resizing={resizingSidebar}
          setResizing={setResizingSidebar}
        />
      </motion.div>

      <div
        style={{
          flexGrow: 1,
          minWidth: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: '100%',
            height: settingsOpen ? 0 : 64,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 11,
            paddingLeft: collapsed ? TITLEBAR_CLEARANCE : 14,
            paddingRight: 16,
          }}
        >
          <IconButton
            icon="panelLeft"
            label={collapsed ? 'Open sidebar' : 'Close sidebar'}
            testId="sidebar-toggle"
            onClick={() => setCollapsed((open) => !open)}
          />
          <div style={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
              {/* No session means no project to name, so the breadcrumb is
                  just the conversation. It used to fall back to the product
                  name here, which read as a project that did not exist. */}
              {activeSpaceName ? (
                <>
                  <text style={{ fontSize: 11, fontFamily: FONT, color: C.tertiary }}>{activeSpaceName}</text>
                  <text style={{ fontSize: 11, fontFamily: FONT, color: C.ghost }}>/</text>
                </>
              ) : null}
              <text
                testId="header-title"
                style={{ fontSize: 14, fontWeight: 600, fontFamily: FONT, color: C.text, whiteSpace: 'nowrap' }}
              >
                {currentTitle}
              </text>
            </div>
            {/* The header's second line only exists while something is worth
                saying. A standing "Ready to help" with a green dot next to it
                was the last piece of chrome that carried no information. */}
            {queueStatus || compactionStatus || turnStatus ? (
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                {queueStatus ? <text testId="queue-status" style={{ fontSize: 10, fontFamily: FONT, color: C.tertiary }}>{queueStatus}</text> : null}
                {compactionStatus ? <text testId="compaction-status" style={{ fontSize: 10, fontFamily: FONT, color: C.accent }}>{compactionStatus}</text> : null}
                {turnStatus ? <text testId="turn-status" style={{ fontSize: 10, fontFamily: FONT, color: C.tertiary }}>{turnStatus}</text> : null}
              </div>
            ) : null}
          </div>
          <div style={{ flexGrow: 1 }} />
        </div>

        <div
          style={{
            width: '100%',
            maxWidth: settingsOpen ? '100%' : CONTENT_MAX_WIDTH,
            flexGrow: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {settingsOpen ? (
            <div
              style={{
                flexGrow: 1,
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'row',
              }}
            >
            <SettingsPanel
              provider={provider}
              providers={providers}
              approvalMode={approvalMode}
              autoCompaction={autoCompaction}
              autoRetry={autoRetry}
              steeringMode={steeringMode}
              followUpMode={followUpMode}
              maxTokens={maxTokens}
              model={model}
              models={models}
              reasoning={reasoning}
              reasoningLevels={reasoningLevels}
              stats={sessionStats}
              exportedPath={exportedPath}
              compactionSummary={compactionSummary}
              branchMessage={branchMessage}
              connectionStatus={connectionStatus}
              runtimeState={runtimeState}
              onPing={pingEngine}
              diagnostics={diagnostics}
              diagnosticsStatus={diagnosticsStatus}
              onCaptureDiagnostics={captureDiagnostics}
              onSaveDiagnostics={saveDiagnostics}
              loginProvider={loginProvider}
              loginKey={loginKey}
              loginStatus={loginStatus}
              sessionPath={sessionPath}
              sessionName={sessionName}
              onSessionPath={setSessionPath}
              onSessionName={setSessionName}
              onSwitchSession={switchSessionByPath}
              onRenameSession={renameSession}
              onLoginProvider={setLoginProvider}
              onLoginKey={setLoginKey}
              onSaveLogin={saveLogin}
              tree={tree}
              bashCommand={bashCommand}
              bashOutput={bashOutput}
              bashRunning={bashRunning}
              diffOutput={diffOutput}
              onBashCommand={setBashCommand}
              onRunBash={runBash}
              onAbortBash={abortBash}
              onGetDiff={loadDiff}
              onLoadTree={loadTree}
              onForkEntry={forkEntry}
              onForkLatest={forkLatest}
              onClone={cloneSession}
              onUndo={undoSession}
              onExport={() => {
                void client.exportHtml().then((result) => {
                  if (result?.path) setExportedPath(result.path)
                }).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
              }}
              onCompact={() => {
                void client.compact().then(setCompactionSummary).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
              }}
              onSnapcompact={() => {
                void client.snapcompact().then(setCompactionSummary).catch((error: unknown) => appendRuntimeError(error instanceof Error ? error.message : String(error)))
              }}
              onProvider={changeProvider}
              onApprovalMode={changeApprovalMode}
              onAutoCompaction={changeAutoCompaction}
              onAutoRetry={changeAutoRetry}
              onSteeringMode={changeSteeringMode}
              onFollowUpMode={changeFollowUpMode}
              onMaxTokens={changeMaxTokens}
              onSetMaxTokens={saveMaxTokens}
              onModel={changeModel}
              onReasoning={changeReasoning}
              onClose={() => setSettingsOpen(false)}
              memoryState={memoryState}
              memoryDraft={memoryDraft}
              memoryEditing={memoryEditing}
              memoryError={memoryError}
              onMemoryDraft={setMemoryDraft}
              onMemoryEdit={startMemoryEdit}
              onMemoryCancel={() => { setMemoryEditing(null); setMemoryDraft('') }}
              onMemorySubmit={() => void submitMemory()}
              onMemoryRemove={(index) => void applyMemoryRemove(index)}
              skills={skills}
              visibleSkills={visibleSkills}
              skillProjects={skillProjects}
              skillsError={skillsError}
              skillPending={skillPending}
              skillScope={skillScope}
              onSkillScope={setSkillScope}
              onSkillToggle={applySkillToggle}
              section={settingsSection}
              onSection={setSettingsSection}
            />
            </div>
          ) : null}
          {!settingsOpen && (messages.length === 0 ? (
            <Welcome />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
            <div
              testId="load-older"
              role="button"
              aria-label="Load earlier messages"
              tabIndex={0}
              onClick={loadOlderMessages}
              onKeyDown={(event) => runButtonKey(event, loadOlderMessages)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                paddingTop: 6,
                paddingBottom: 10,
                cursor: hasOlder && !loadingOlder ? 'pointer' : 'default',
                opacity: hasOlder ? 1 : 0,
              }}
            >
              <text style={{ fontSize: 11, fontFamily: FONT, color: C.tertiary }}>
                {loadingOlder ? 'Loading earlier messages\u2026' : 'Load earlier messages'}
              </text>
            </div>
            <virtual-list
              testId="message-list"
              role="log"
              aria-label="Conversation"
              estimatedItemHeight={78}
              followTail
              style={{
                flexGrow: 1,
                minHeight: 0,
                width: '100%',
                maxWidth: CONTENT_MAX_WIDTH,
                minWidth: 0,
                alignSelf: 'center',
                paddingLeft: 20,
                paddingRight: 20,
              }}
            >
              {messages.map((message) => (
                <MessageRow key={message.id} message={message} />
              ))}
            </virtual-list>
            </div>
          ))}
          {!settingsOpen ? <ToolActivityPanel activities={toolActivities} /> : null}
          {!settingsOpen && pendingInteraction ? (
            <InteractionCard
              interaction={pendingInteraction}
              onAllow={() => resolveApproval(true)}
              onDeny={() => resolveApproval(false)}
              onAnswer={resolveQuestion}
            />
          ) : null}
          {!settingsOpen && dockCommands.length > 0 ? (
            <CommandDock
              commands={dockCommands}
              onPick={(command) => {
                setDraft(`/${command.name} `)
                void runCommand(command)
              }}
            />
          ) : null}
          {!settingsOpen ? <Composer
            draft={draft}
            busy={busy}
            mode={client.mode}
            willStopAgent={willStopAgent}
            runningAgentName={runningElsewhere ? (sessions.find((item) => item.path === runningElsewhere)?.name || 'the running agent') : ''}
            onChange={setDraft}
            onSubmit={sendMessage}
            onStop={stopCurrentAgent}
            onSteer={() => queueMessage('steer')}
            onFollowUp={() => queueMessage('followUp')}
          /> : null}
        </div>
      </div>
    </div>
  )
}

const isEntryPoint =
  typeof Bun !== 'undefined'
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof window !== 'undefined'

if (isEntryPoint) {
  const client = (() => {
    if (typeof Bun === 'undefined') return createLocalAgentClient(createAgentReply)
    try {
      return createEscapeAgentClient()
    } catch {
      return createLocalAgentClient(createAgentReply)
    }
  })()

  render(<ChatApp client={client} />, {
    title: 'Escape',
    appName: 'Escape',
    width: 1100,
    height: 760,
    // macOS HIG: freely resizable, with a floor that keeps the transcript and
    // composer usable. Escape's sidebar is 208-480, so anything under ~660
    // would crush the reading column.
    resizable: true,
    minWidth: 680,
    minHeight: 480,
    titlebarTransparent: true,
    windowBackground: 'blurred',
    trafficLightX: 16,
    trafficLightY: 17,
    focus: typeof process === 'undefined' || process.env.GPUIX_BACKGROUND !== '1',
    // Window-level keys stand in for the menu bar, which GPUIX does not offer.
    onKeyDown: (event) => {
      const command = matchCommand(event as KeyEventLike)
      if (!command) return
      dispatchWindowCommand(command)
    },
  })
}
