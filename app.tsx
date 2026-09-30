/**
 * The GPUIX chat example, rendered directly on the GPU.
 *
 * It demonstrates a transparent titlebar, traffic lights in the sidebar,
 * graphite surfaces, composer chips, and a workspace footer. Threads, sends,
 * and chrome controls are interactive. Replies stay in this demo.
 *
 * Run on desktop: cd examples && bun --hot chat.tsx
 * Run in a browser: bun run web
 * Slow CPU: THROTTLE=utility bun --hot chat.tsx
 */

import os from 'os'
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { C, type Palette } from './theme-tokens'
import { normaliseKey } from './keys'
import { DURATION, fadeIn } from './motion'
import { DesignRun, type DesignOutcome, type DesignPhase } from './design-run'
import { createEscapeAgentClient, TRANSCRIPT_PAGE } from './agent-client'
import { systemFonts } from './fonts'
import type { FontOption, SystemFonts } from './fonts'
import type {
  AgentClient,
  AgentEvent,
  ModelInfo,
  Project,
  ProviderSummary,
  SessionSummary,
  VcsFileStatus,
  VcsStatus,
} from './agent-client'
import {
  applyMacCpuThrottleFromEnv,
  motion,
  render,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  useGpuix,
  useWindowInsets,
  type Props,
  type PublicInstance,
  type StyleDesc,
} from '@gpuix/react'
// Local shims for the repo-tip `Button` + `Dialog` primitives used by the
// reference chat example. `@gpuix/react@0.10.0` (latest on npm) does not export
// them yet, so they live here until the published package catches up. Visuals
// are 1:1 with the example: Button is a pressable with hover/active washes,
// Dialog is a centered card over a dimming backdrop.
function Button({
  testId,
  disabled,
  style,
  onClick,
  children,
  ...rest
}: {
  testId?: string
  disabled?: boolean
  style?: StyleDesc
  onClick?: () => void
  children?: React.ReactNode
  [key: string]: unknown
}) {
  return (
    <div
      testId={testId}
      role="button"
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onClick}
      onKeyDown={(event: { key?: string }) => {
        if (!disabled && onClick && (event.key === 'enter' || event.key === ' ')) onClick()
      }}
      style={{ ...(style as object), cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.35 : (style as { opacity?: number } | undefined)?.opacity }}
      {...(rest as object)}
    >
      {children}
    </div>
  )
}
const DialogContext = React.createContext<{ close: () => void }>({ close: () => {} })
function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange?: (next: boolean) => void
  children?: React.ReactNode
}) {
  if (!open) return null
  const close = () => onOpenChange?.(false)
  return <DialogContext.Provider value={{ close }}>{children}</DialogContext.Provider>
}
function DialogPortal({ children }: { children?: React.ReactNode }) {
  return <>{children}</>
}
function DialogBackdrop({ style }: { style?: StyleDesc }) {
  const { close } = React.useContext(DialogContext)
  return (
    <div
      onClick={close}
      style={{
        position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
        ...(style as object),
      }}
    />
  )
}
function DialogPopup({
  initialFocus,
  style,
  children,
}: {
  initialFocus?: React.RefObject<PublicInstance | null>
  style?: StyleDesc
  children?: React.ReactNode
}) {
  const { close } = React.useContext(DialogContext)
  const { renderer } = useGpuix()
  const prevRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    try {
      prevRef.current = (renderer as unknown as { getFocusedElementId?: () => number | null })?.getFocusedElementId?.() ?? null
    } catch { prevRef.current = null }
    const id = initialFocus?.current?.id
    if (id != null) {
      try { (renderer as unknown as { focusElement?: (id: number) => void })?.focusElement?.(id) } catch {}
    }
    return () => {
      if (prevRef.current != null) {
        try { (renderer as unknown as { focusElement?: (id: number) => void })?.focusElement?.(prevRef.current) } catch {}
      }
    }
  }, [renderer])
  return (
    <div
      onKeyDown={(event: { key?: string }) => {
        if (event.key === 'escape' || event.key === 'Escape') close()
      }}
      style={{
        position: 'absolute', left: 0, top: 0, right: 0, bottom: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div style={{ ...(style as object), pointerEvents: 'auto' }}>{children}</div>
    </div>
  )
}
type RendererLike = { clearSelection?: () => void }
let moduleRenderer: RendererLike | null = null
function setModuleRenderer(renderer: unknown) {
  moduleRenderer = (renderer ?? null) as RendererLike | null
}

/**
 * Drops any in-flight text selection.
 *
 * A drag on a resize handle starts as a press on ordinary text, which the
 * renderer treats as the beginning of a selection. Without this the drag
 * leaves a highlighted wash across every file name it swept past, and that
 * selection outlives the drag.
 */
function clearTextSelection() {
  try {
    moduleRenderer?.clearSelection?.()
  } catch {}
}

function DialogTitle({ style, children }: { style?: StyleDesc; children?: React.ReactNode }) {
  return <div style={style as object}>{children}</div>
}
function DialogClose({
  testId,
  style,
  children,
}: {
  testId?: string
  style?: StyleDesc
  children?: React.ReactNode
}) {
  const { close } = React.useContext(DialogContext)
  return (
    <div testId={testId} role="button" aria-label="Close" tabIndex={0}
      onClick={close}
      onKeyDown={(event: { key?: string }) => {
        if (event.key === 'enter' || event.key === ' ') close()
      }}
      style={{ ...(style as object), cursor: 'pointer' }}>
      {children}
    </div>
  )
}
import { SafeMdxRenderer } from 'safe-mdx'
import { mdxParse } from 'safe-mdx/parse'
import type { Root } from 'mdast'
import iconCompose from './assets/icons/compose.svg' with { type: 'text' }
import iconSearch from './assets/icons/search.svg' with { type: 'text' }
import iconSquarePen from './assets/icons/square-pen.svg' with { type: 'text' }
import iconFolderPlus from './assets/icons/folder-plus.svg' with { type: 'text' }
import iconClose from './assets/icons/close.svg' with { type: 'text' }
import iconSidebar from './assets/icons/panel-left.svg' with { type: 'text' }
import iconPanelRight from './assets/icons/panel-right.svg' with { type: 'text' }
import iconArrowLeft from './assets/icons/arrow-left.svg' with { type: 'text' }
import iconArrowRight from './assets/icons/arrow-right.svg' with { type: 'text' }
import iconFolder from './assets/icons/folder.svg' with { type: 'text' }
import iconFile from './assets/icons/file.svg' with { type: 'text' }
import iconSettings from './assets/icons/settings.svg' with { type: 'text' }
import iconGitBranch from './assets/icons/git-branch.svg' with { type: 'text' }
import iconLaptop from './assets/icons/laptop.svg' with { type: 'text' }
import iconLockOpen from './assets/icons/lock-open.svg' with { type: 'text' }
import iconLock from './assets/icons/lock.svg' with { type: 'text' }
import iconList from './assets/icons/list.svg' with { type: 'text' }
import iconZap from './assets/icons/zap.svg' with { type: 'text' }
import iconPencil from './assets/icons/pencil.svg' with { type: 'text' }
import iconChevronDown from './assets/icons/chevron-down.svg' with { type: 'text' }
import iconChevronRight from './assets/icons/chevron-right.svg' with { type: 'text' }
import iconListFilter from './assets/icons/list-filter.svg' with { type: 'text' }
import iconSparkle from './assets/icons/sparkle.svg' with { type: 'text' }
import iconWrench from './assets/icons/wrench.svg' with { type: 'text' }
import iconSend from './assets/icons/arrow-up.svg' with { type: 'text' }
import iconCopy from './assets/icons/copy.svg' with { type: 'text' }
import iconCheck from './assets/icons/check.svg' with { type: 'text' }
import iconRetry from './assets/icons/rotate-ccw.svg' with { type: 'text' }
import iconThumbsUp from './assets/icons/thumbs-up.svg' with { type: 'text' }
import iconThumbsDown from './assets/icons/thumbs-down.svg' with { type: 'text' }
import iconShare from './assets/icons/share.svg' with { type: 'text' }
import iconStop from './assets/icons/stop.svg' with { type: 'text' }
import iconMore from './assets/icons/ellipsis.svg' with { type: 'text' }
import iconCpu from './assets/icons/cpu.svg' with { type: 'text' }
import iconSliders from './assets/icons/sliders-horizontal.svg' with { type: 'text' }

export type ThemeId = 'dark' | 'midnight' | 'ember'

export const THEMES: Record<ThemeId, { label: string; palette: Palette }> = {
  dark: {
    label: 'Dark',
    palette: { ...C },
  },
  midnight: {
    label: 'Midnight',
    palette: {
      canvas: '#0B0E14',
      sidebar: '#090C11',
      raised: '#151B26',
      composer: '#11161F',
      overlay: '#E6EAF20D',
      overlayStrong: '#E6EAF217',
      item: '#F0F0F00F',
      border: '#E6EAF212',
      borderStrong: '#E6EAF224',
      sidebarBorder: '#1C2330',
      text: '#E6EAF2',
      secondary: '#9AA4B2',
      tertiary: '#6B7484',
      // See theme-tokens: muted is de-emphasized text and clears 5:1 on every
      // surface, where ghost is 2.20:1 on raised and tertiary 3.66:1.
      muted: '#818B9C',
      ghost: '#4B5261',
      accent: '#7AA2F7',
      inverse: '#E7E9EC',
      onInverse: '#0B0E14',
      codeText: '#9CD3FF',
      success: '#4ADE9B',
      warning: '#F0B45C',
      error: '#FF8A8A',
      successWash: '#4ADE9B14',
      warningWash: '#F0B45C14',
      errorWash: '#FF8A8A14',
      accentWash: '#7AA2F714',
    },
  },
  ember: {
    label: 'Ember',
    palette: {
      canvas: '#171312',
      sidebar: '#141110',
      raised: '#221C19',
      composer: '#1E1815',
      overlay: '#F2E8E00D',
      overlayStrong: '#F2E8E017',
      item: '#FFF6EC0F',
      border: '#F2E8E012',
      borderStrong: '#F2E8E024',
      sidebarBorder: '#2B2521',
      text: '#EDE6DD',
      secondary: '#A89C90',
      tertiary: '#7D7268',
      muted: '#968B80',
      ghost: '#57504A',
      accent: '#E2795B',
      inverse: '#EDE6DD',
      onInverse: '#171312',
      codeText: '#E0A882',
      success: '#4ADE9B',
      warning: '#F0B45C',
      error: '#FF8A8A',
      successWash: '#4ADE9B14',
      warningWash: '#F0B45C14',
      errorWash: '#FF8A8A14',
      accentWash: '#E2795B14',
    },
  },
}

export const SANS_FONTS = [
  { id: 'SF Pro', label: 'SF Pro', family: 'SF Pro' },
  { id: 'Helvetica Neue', label: 'Helvetica Neue', family: 'Helvetica Neue' },
  { id: 'Arial', label: 'Arial', family: 'Arial' },
  { id: 'Verdana', label: 'Verdana', family: 'Verdana' },
  { id: 'Georgia', label: 'Georgia', family: 'Georgia' },
]

export const MONO_FONTS = [
  { id: 'Menlo', label: 'Menlo', family: 'Menlo' },
  { id: 'Courier New', label: 'Courier New', family: 'Courier New' },
  { id: 'Courier', label: 'Courier', family: 'Courier' },
]

export const SANS_SIZES = [13, 14, 15, 16, 17, 18]
export const MONO_SIZES = [11, 12, 13, 14, 15]

export type LineHeightMode = 'comfortable' | 'compact'

/** Body copy for user bubbles and the composer input. Sized by the interface font size. */
const UI_TEXT: StyleDesc = { fontSize: 14, lineHeight: 20 }
/** Inline code runs. Sized by the monospace font size. */
const CODE_INLINE: StyleDesc = { fontSize: 13 }
/** Table cell wrapping and container overflow. Driven by the word-wrap toggle. */
const TABLE_CELL: StyleDesc = { whiteSpace: 'nowrap' }
const TABLE_SCROLL: StyleDesc = { overflowX: 'scroll' }

/**
 * Applies type sizes to the module-level style objects the renderers read.
 * Same pattern as applyAppearance: component styles read these at render
 * time, so one idempotent assignment per ChatApp render keeps a single
 * source of truth without threading size props through every component.
 */
export function applyTypography(
  sansSize: number,
  monoSize: number,
  lineHeight: LineHeightMode,
  wordWrap: boolean,
): void {
  const bodyLineHeight = Math.round(sansSize * (lineHeight === 'compact' ? 1.45 : 1.73))
  const monoLineHeight = Math.round(monoSize * 1.6)
  Object.assign(MD_TEXT, { fontSize: sansSize, lineHeight: bodyLineHeight })
  Object.assign(UI_TEXT, { fontSize: sansSize, lineHeight: Math.round(sansSize * 1.4) })
  Object.assign(CODE_INLINE, { fontSize: monoSize })
  Object.assign(CHAT_THEME.metrics, {
    mdTextSize: sansSize,
    mdLineHeight: bodyLineHeight,
    codeTextSize: monoSize,
    codeLineHeight: monoLineHeight,
  })
  Object.assign(TABLE_CELL, { whiteSpace: wordWrap ? 'normal' : 'nowrap' })
  Object.assign(TABLE_SCROLL, { overflowX: wordWrap ? 'visible' : 'scroll' })
}

/**
 * Applies the selected appearance to the module palette and every derived
 * module-level style object, then lets the current render pick it up.
 *
 * All component styles read `C` at render time, but a handful of plain objects
 * (`MENU`, the code card, `CHAT_THEME`, `MD_TEXT`) are evaluated once at
 * import. Re-assigning them here keeps one source of truth without threading
 * a theme prop through every component. Single-window app: the only writer is
 * ChatApp's own render, so this is idempotent, not shared mutable state.
 */
export function applyAppearance(theme: ThemeId, sans: string, mono: string): void {
  Object.assign(C, THEMES[theme].palette)
  FONT_SANS = sans
  FONT_MONO = mono
  Object.assign(MENU, { backgroundColor: C.raised, borderColor: C.borderStrong })
  Object.assign(CODE_CARD_STYLE, { borderColor: C.border })
  Object.assign(CHAT_THEME, {
    text: C.text,
    textMuted: C.secondary,
    textFaint: C.tertiary,
    textDim: C.secondary,
    border: C.border,
    bg: C.canvas,
    accent: C.accent,
    caret: C.accent,
    fontSans: FONT_SANS,
    fontMono: FONT_MONO,
    codeText: C.codeText,
  })
  Object.assign(MD_TEXT, { color: C.text })
}

const SIDEBAR_WIDTH = 252
const TRAFFIC_LIGHT_CLEARANCE =
  typeof process !== 'undefined' && process.platform === 'darwin' ? 86 : 8
const CONTENT_MAX_WIDTH = 720
const TITLEBAR_HEIGHT = 48

let FONT_SANS = typeof window === 'undefined' ? 'Helvetica' : 'IBM Plex Sans'
let FONT_MONO = typeof window === 'undefined' ? 'Menlo' : 'Lilex'

const ICONS = {
  // squarePen and folderPlus are the 24x24 stroked set the rest of the icons
  // use. compose and folder are the only two filled strays, which is why the
  // sidebar actions that used them sat in one row looking like three different
  // drawing styles rather than three buttons.
  squarePen: iconSquarePen,
  close: iconClose,
  folderPlus: iconFolderPlus,
  compose: iconCompose,
  search: iconSearch,
  sidebar: iconSidebar,
  panelRight: iconPanelRight,
  arrowLeft: iconArrowLeft,
  arrowRight: iconArrowRight,
  folder: iconFolder,
  file: iconFile,
  settings: iconSettings,
  gitBranch: iconGitBranch,
  laptop: iconLaptop,
  lockOpen: iconLockOpen,
  lock: iconLock,
  list: iconList,
  zap: iconZap,
  pencil: iconPencil,
  chevronDown: iconChevronDown,
  chevronRight: iconChevronRight,
  listFilter: iconListFilter,
  sparkle: iconSparkle,
  wrench: iconWrench,
  send: iconSend,
  copy: iconCopy,
  check: iconCheck,
  retry: iconRetry,
  thumbsUp: iconThumbsUp,
  thumbsDown: iconThumbsDown,
  share: iconShare,
  stop: iconStop,
  more: iconMore,
  cpu: iconCpu,
  sliders: iconSliders,
} as const

type IconName = keyof typeof ICONS

function Icon({ name, size = 14, color }: { name: IconName; size?: number; color: string }) {
  return (
    <svg
      source={ICONS[name]}
      style={{ width: size, height: size, flexShrink: 0, color, pointerEvents: 'none' }}
    />
  )
}

let CHAT_THEME = {
  text: C.text,
  textMuted: C.secondary,
  textFaint: C.tertiary,
  textDim: C.secondary,
  border: C.border,
  bg: C.canvas,
  accent: C.accent,
  caret: C.accent,
  fontSans: FONT_SANS,
  fontMono: FONT_MONO,
  codeText: C.codeText,
  codeWash: '#E6EAF214',
  metrics: {
    mdTextSize: 14,
    mdLineHeight: 22,
    mdBlockGap: 14,
    mdHeadingSizes: [20, 16, 14, 14],
    mdHeadingLineHeights: [28, 24, 22, 22],
    codeTextSize: 12.5,
    codeLineHeight: 20,
    diffLineHeight: 20,
    diffFileHeaderHeight: 34,
  },
}

let themeCacheKey = ''

/**
 * The theme object handed to native elements. Identity changes if and only
 * if an appearance input changed: applyAppearance/applyTypography mutate the
 * module palette in place, which keeps the old reference equal and makes
 * React skip the update — native code and diff blocks then paint stale
 * fonts forever. Reading through here re-snapshots on change while keeping
 * a stable reference across unrelated renders, so typing never repaints
 * code it didn't touch.
 */
export function currentTheme(): typeof CHAT_THEME {
  const metrics = CHAT_THEME.metrics
  const key = [
    C.text, C.secondary, C.tertiary, C.border, C.canvas, C.accent, C.codeText,
    FONT_SANS, FONT_MONO,
    metrics.mdTextSize, metrics.mdLineHeight, metrics.codeTextSize, metrics.codeLineHeight,
  ].join('|')
  if (key !== themeCacheKey) {
    themeCacheKey = key
    CHAT_THEME = {
      ...CHAT_THEME,
      text: C.text,
      textMuted: C.secondary,
      textFaint: C.tertiary,
      textDim: C.secondary,
      border: C.border,
      bg: C.canvas,
      accent: C.accent,
      caret: C.accent,
      fontSans: FONT_SANS,
      fontMono: FONT_MONO,
      codeText: C.codeText,
      metrics: { ...metrics },
    }
  }
  return CHAT_THEME
}

type MessageRole = 'user' | 'assistant'

type Message = {
  id: string
  role: MessageRole
  content: string
  turnId?: string
  createdAt?: number
  /**
   * Tool activity for this turn, present when a transcript was reloaded from
   * the engine. Live turns track this in the separate `activities` list; a
   * stored page has no such list, so the calls ride here instead. Either way
   * they stay out of `content` — tool logs are not prose.
   */
  tools?: ToolActivity[]
}

type ToolActivity = {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  turnId?: string
  /** One readable line of the call arguments, shown in the folded row. */
  args?: string
  /** Result text, for a reloaded turn. */
  output?: string
  createdAt?: number
  endedAt?: number
}

type TimelineRow =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'activity'; key: string; turnId: string; activities: ToolActivity[] }
  | { kind: 'diff'; key: string; turnId: string; patch: string }

export function deriveTimelineRows(
  messages: readonly Message[],
  activities: readonly ToolActivity[],
  diffs: Readonly<Record<string, string>> = {},
): TimelineRow[] {
  const byTurn = new Map<string, ToolActivity[]>()
  const add = (turnId: string, activity: ToolActivity) => {
    const bucket = byTurn.get(turnId)
    if (bucket) bucket.push(activity)
    else byTurn.set(turnId, [activity])
  }
  for (const activity of activities) {
    if (!activity.turnId) continue
    add(activity.turnId, activity)
  }
  // A reloaded transcript carries its tools on the message, with no separate
  // activity list. Seeding the same buckets here is what makes a reloaded turn
  // fold identically to a live one, instead of printing the calls as prose.
  for (const message of messages) {
    if (!message.turnId || !message.tools?.length) continue
    for (const tool of message.tools) add(message.turnId, tool)
  }

  // A turn's shape: work first, then the answer, then what it changed. The work
  // is a header on the turn, not a row after every individual call, and the
  // changes card is the receipt at the bottom — the answer is what the reader
  // came for and the edits are the supporting detail.
  const rows: TimelineRow[] = []
  const emittedWork = new Set<string>()

  messages.forEach((message, index) => {
    const turnId = message.turnId
    const isTurnStart = index === 0 || messages[index - 1]?.turnId !== turnId
    const isTurnEnd = messages[index + 1]?.turnId !== turnId

    if (turnId && isTurnStart) {
      const work = byTurn.get(turnId)
      if (work?.length && !emittedWork.has(turnId)) {
        emittedWork.add(turnId)
        rows.push({ kind: 'activity', key: `a:${turnId}`, turnId, activities: work })
      }
    }

    rows.push({ kind: 'message', key: `m:${message.id}`, message })

    if (turnId && isTurnEnd) {
      const patch = diffs[turnId]
      if (patch) rows.push({ kind: 'diff', key: `d:${turnId}`, turnId, patch })
    }
  })
  return rows
}

export function groupForSession(updatedAt: number, now: number): string {
  const day = 24 * 60 * 60 * 1000
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const diff = startOfToday.getTime() - updatedAt
  if (diff <= 0) return 'Today'
  if (diff < day) return 'Yesterday'
  if (now - updatedAt < 30 * day) return 'This Month'
  return 'Older'
}

export function relativeTime(updatedAt: number, now: number): string {
  const delta = Math.max(0, now - updatedAt)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'now'
  if (delta < hour) return `${Math.floor(delta / minute)}m`
  if (delta < day) return `${Math.floor(delta / hour)}h`
  return `${Math.floor(delta / day)}d`
}

interface Conversation {
  id: string
  title: string
  group: string
  project: string
  time: string
}

const SAFE_MDX_STRESS = `# React-composed Markdown

This message uses **safe-mdx**, *styled spans*, ~~deleted text~~, an
\`inline code value\`, and [a link](https://github.com/holocron-hq/safe-mdx).

> The parser runs in TypeScript. Every Markdown node becomes a normal React component.
>
> GPUIX renders the resulting \`div\`, \`text\`, and \`code\` tree.

- nested **inline formatting** inside a list
- a second item with a long sentence that must wrap without leaving the transcript column
- [x] a GFM task item

| Path | Renderer | Native Markdown element | Host nodes | Scroll | When to use |
|:-----|:---------|:------------------------|-----------:|:-------|:------------|
| safe-mdx | React tree of div and text | no | many | overflow-x on this grid | Custom MDX components and React state inside a message |
| pulldown-cmark | one native markdown node | yes | one | overflow-x inside Rust | Default chat transcript. Cheapest paint. |
| grid table | one CSS grid of cells | no | one per cell | overflow-x on the flex parent | Wide comparison tables that must stay readable |

\`\`\`typescript
const tree = mdxParse(source)
return <SafeMdxRenderer markdown={source} mdast={tree} />
\`\`\`

<Callout title="Custom MDX component">
  MDX components also map to ordinary GPUIX React components.
</Callout>`

function IconButton({
  icon,
  onClick,
  dimmed,
  size = 14,
  testId,
  ariaLabel,
}: {
  icon: IconName
  onClick?: () => void
  dimmed?: boolean
  size?: number
  testId?: string
  /**
   * The accessible name. An icon-only control has no visible text, so without
   * this a screen reader announces a bare button and the control is unusable
   * rather than merely ugly.
   */
  ariaLabel?: string
}) {
  return (
    <Button
      testId={testId}
      aria-label={ariaLabel}
      disabled={dimmed}
      style={{
        width: 26,
        height: 26,
        flexShrink: 0,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        opacity: dimmed ? 0.35 : 1,
        hover: dimmed ? undefined : { backgroundColor: C.overlay },
        active: dimmed ? undefined : { backgroundColor: C.overlayStrong },
      }}
      onClick={onClick}
    >
      <Icon name={icon} size={size} color={C.tertiary} />
    </Button>
  )
}

function SidebarAction({
  icon,
  label,
  onClick,
  testId,
}: {
  icon: IconName
  label: string
  onClick?: () => void
  testId?: string
}) {
  return (
    <Button
      testId={testId}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        height: 32,
        paddingLeft: 4,
        paddingRight: 4,
        borderRadius: 7,
        cursor: 'pointer',
        hover: { backgroundColor: C.item },
        active: { backgroundColor: C.overlayStrong },
      }}
    >
      <div
        style={{
          width: 20,
          height: 20,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={14} color={C.secondary} />
      </div>
      <text style={{ fontSize: 13, color: C.secondary }}>{label}</text>
    </Button>
  )
}

function ConversationRow({
  conversation,
  active,
  onSelect,
  scopeProject,
}: {
  conversation: Conversation
  active: boolean
  onSelect: (id: string) => void
  /**
   * The project this list is already scoped to, when there is one.
   *
   * A row used to name its project under the title, which under a "Recent in
   * aoi" heading meant the word "aoi" repeated once per row in the most-repeated
   * position on screen. Set this and the line is dropped; leave it unset for
   * lists that genuinely span projects, like the search overlay.
   */
  scopeProject?: string
}) {
  return (
    <Button
      testId={`thread-${conversation.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 7,
        paddingBottom: 7,
        borderRadius: 7,
        cursor: 'pointer',
        backgroundColor: active ? C.item : '#00000000',
        hover: { backgroundColor: C.item },
      }}
      onClick={() => onSelect(conversation.id)}
    >
      <text
        style={{
          fontSize: 13.5,
          lineHeight: 18,
          color: C.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {conversation.title}
      </text>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        {scopeProject === undefined && (
          <>
            <Icon name="folder" size={12.5} color={C.tertiary} />
            <text
              style={{
                fontSize: 13,
                lineHeight: 15,
                color: C.tertiary,
                flexGrow: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
              }}
            >
              {conversation.project}
            </text>
          </>
        )}
        {scopeProject !== undefined && <div style={{ flexGrow: 1 }} />}
        <text style={{ fontSize: 12.5, color: C.muted, flexShrink: 0 }}>{conversation.time}</text>
      </div>
    </Button>
  )
}

/**
 * One project in the sidebar's list.
 *
 * The current project is marked with a check on the right and with
 * `aria-selected`, never a bar down the left edge — that is a hard rule in
 * DESIGN_SYSTEM.md and it is the reason this row has no left padding accent to
 * remove. The check and the background are for sighted users; the state
 * attribute is the part that is actually announced.
 */
function ProjectRow({
  project,
  current,
  onSelect,
}: {
  project: Project
  current: boolean
  onSelect: (path: string) => void
}) {
  return (
    <div
      testId={`sidebar-project-${project.path}`}
      // A listbox option, because choosing a project *selects* it: one project
      // is current out of the set. That is also the only state attribute the
      // platform actually forwards — `aria-current` is silently dropped, so
      // using it would have looked like state to anyone reading this and would
      // have reached no assistive technology at all.
      role="option"
      aria-selected={current}
      aria-label={current ? `${projectName(project.path)}, current project` : projectName(project.path)}
      tabIndex={0}
      onClick={() => onSelect(project.path)}
      onKeyDown={(event: { key?: string }) => {
        const key = normaliseKey(event.key)
        if (key === 'enter' || key === 'space') onSelect(project.path)
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: 28,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 6,
        cursor: 'pointer',
        // The label above sits 8px in from the list's own 10px padding, so the
        // row's 8px lined its text up with the label. With the fill gone there
        // is no slab edge to align, and the text lining up with the section
        // label above it is the alignment that actually reads.
        // No fill for the current project. It was a filled slab spanning almost
        // the whole sidebar to mark a three-letter name, and it was the only
        // filled surface in the column, so it became the first thing your eye
        // landed on in the entire window. A selection marker has to be quieter
        // than the content it labels. The check and the weight say it, and the
        // accessible name already says "current project", so the fill was
        // carrying nothing that was not already carried twice.
        hover: { backgroundColor: C.item },
      }}
    >
      <Icon name="folder" size={14} color={current ? C.text : C.secondary} />
      <text
        style={{
          fontSize: 13,
          // Weight rather than a background, so the current project is legible
          // in peripheral vision without competing with the transcript.
          fontWeight: current ? 600 : 400,
          color: current ? C.text : C.secondary,
          flexGrow: 1,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {projectName(project.path)}
      </text>
      {current && <Icon name="check" size={13} color={C.secondary} />}
    </div>
  )
}

/**
 * The recent sessions of the current project, shown in the chat area when no
 * session is open.
 *
 * These are the engine's own sessions, not a local cache: `list_sessions` is
 * scoped to the current working directory, so switching the project in the
 * sidebar genuinely changes this list rather than filtering it. The composer
 * stays live underneath, and `send` already opens a session when none is
 * active, so typing here starts a new chat without a separate "new" gesture.
 */
function RecentSessions({
  conversations,
  project,
  onSelect,
}: {
  conversations: Conversation[]
  project: string
  onSelect: (id: string) => void
}) {
  return (
    <div
      testId="recent-sessions"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        minHeight: 0,
        overflowY: 'scroll',
        alignItems: 'center',
        paddingTop: 48,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            height: 28,
            paddingLeft: 8,
            paddingRight: 8,
          }}
        >
          <text style={{ fontSize: 13, fontWeight: 500, color: C.secondary, flexGrow: 1 }}>
            {project === '' ? 'Recent sessions' : `Recent in ${projectName(project)}`}
          </text>
        </div>
        {conversations.length === 0 ? (
          <text
            testId="recent-sessions-empty"
            style={{ fontSize: 12, color: C.muted, paddingLeft: 8, paddingTop: 4 }}
          >
            No sessions yet. Send a message to start one.
          </text>
        ) : (
          groupConversations(conversations).map((group) => (
            <div key={group.name} style={{ display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  height: 26,
                  paddingLeft: 8,
                  paddingRight: 8,
                }}
              >
                <text style={{ fontSize: 12, color: C.muted }}>{group.name}</text>
              </div>
              {group.items.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={false}
                  onSelect={onSelect}
                  scopeProject={project}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * Sessions grouped under their recency heading, in the order given.
 *
 * "Recent" without a Today/Yesterday split is just a list, and the split is
 * what lets someone find this morning's work without reading every title.
 */
function groupConversations(conversations: Conversation[]): { name: string; items: Conversation[] }[] {
  const out: { name: string; items: Conversation[] }[] = []
  for (const conversation of conversations) {
    const last = out[out.length - 1]
    if (last && last.name === conversation.group) last.items.push(conversation)
    else out.push({ name: conversation.group, items: [conversation] })
  }
  return out
}

function Sidebar({
  projects,
  currentProject,
  onSelectProject,
  onCollapse,
  onNewTask,
  onSearch,
  onAddProject,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onSettings,
}: {
  projects: Project[]
  currentProject: string
  onSelectProject: (path: string) => void
  onCollapse: () => void
  onNewTask: () => void
  onSearch: () => void
  onAddProject: () => void
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onSettings: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        height: '100%',
        backgroundColor: C.sidebar,
        userSelect: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: TITLEBAR_HEIGHT,
          flexShrink: 0,
        }}
      >
        <div style={{ width: TRAFFIC_LIGHT_CLEARANCE, height: '100%', flexShrink: 0 }} />
        <IconButton
          icon="sidebar"
          size={16}
          testId="sidebar-collapse"
          onClick={onCollapse}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 2,
            marginLeft: 6,
          }}
        >
          <IconButton icon="arrowLeft" dimmed={!canGoBack} testId="history-back" onClick={onBack} />
          <IconButton
            icon="arrowRight"
            dimmed={!canGoForward}
            testId="history-forward"
            onClick={onForward}
          />
        </div>
      </div>

      {/* The three actions sit on their own row under the traffic lights rather
          than sharing the title bar with them. On that row they crowded the
          history arrows and read as part of the window furniture; here they read
          as what they are, which is the sidebar's own controls. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          height: 30,
          flexShrink: 0,
          paddingRight: 8,
        }}
      >
        <div style={{ flexGrow: 1 }} />
        <IconButton
          icon="squarePen"
          testId="new-task"
          ariaLabel="New task"
          onClick={onNewTask}
        />
        <IconButton icon="search" testId="search" ariaLabel="Search" onClick={onSearch} />
        <IconButton
          icon="folderPlus"
          testId="add-project"
          ariaLabel="Add project"
          onClick={onAddProject}
        />
      </div>

      {/* Projects live at the top of the sidebar and are the switcher, so the
          session list moved into the chat area. Keeping both would show the
          current project twice and offer two controls that do one job. */}
      <div
        testId="sidebar-projects"
        role="listbox"
        aria-label="Projects"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          maxHeight: '45%',
          overflowY: 'scroll',
          paddingLeft: 10,
          paddingRight: 10,
        }}
      >
        {/* 12/muted, the same as every group label in the content. It was 13 at
            weight 500, which made the sidebar's one section label louder than
            every section label in the main area and nearly as loud as the window
            title, so there was no way to tell navigation from content. Chrome
            recedes; content leads. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            height: 28,
            paddingLeft: 8,
            paddingRight: 8,
          }}
        >
          <text style={{ fontSize: 12, color: C.muted, flexGrow: 1 }}>Projects</text>
        </div>
        {projects.length === 0 ? (
          <text
            testId="sidebar-projects-empty"
            style={{ fontSize: 12, color: C.muted, paddingLeft: 8, paddingTop: 2 }}
          >
            No projects yet
          </text>
        ) : (
          projects.map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              current={project.path === currentProject}
              onSelect={onSelectProject}
            />
          ))
        )}
      </div>

      {/* The agents section belongs at the bottom of this sidebar and is
          deliberately absent. It has to list every running agent, and the
          engine holds exactly one (`s.agent`) and refuses to switch sessions
          while it is mid-turn, so any list here could only ever have one row.
          A section that implies concurrency the engine does not have is worse
          than no section; it goes in when the engine can populate it. */}

      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          height: 40,
          flexShrink: 0,
          paddingLeft: 10,
          paddingRight: 10,
        }}
      >
        <IconButton icon="settings" testId="settings" onClick={onSettings} />
      </div>
    </div>
  )
}

function UserTurn({ text }: { text: string }) {
  return (
    <div
      testId="user-turn"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        width: '100%',
      }}
    >
      <div
        style={{
          maxWidth: 540,
          minWidth: 0,
          backgroundColor: C.accentWash,
          borderWidth: 1,
          borderColor: C.borderStrong,
          borderRadius: 12,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
        }}
      >
        <text style={{ ...UI_TEXT, color: C.text, minWidth: 0, maxWidth: '100%' }}>{text}</text>
      </div>
    </div>
  )
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `Worked for ${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Worked for ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  return `Worked for ${hours} hour${hours === 1 ? '' : 's'}`
}

function WorkedFor({
  duration,
  tools,
}: {
  duration: string
  tools?: { name: string; status: 'running' | 'done' | 'error'; args?: string }[]
}) {
  const [open, setOpen] = useState(false)
  const running = tools?.some((t) => t.status === 'running') ?? false
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      {/* A turn header, not a divider: label then chevron, flush left, with the
          rules removed. The flanking lines made it read as a section break
          between two blocks of prose rather than as this turn's own receipt. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={duration}
        testId="work-fold-toggle"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') setOpen((value) => !value) }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 5,
          height: 22,
          width: '100%',
          flexShrink: 0,
          cursor: 'pointer',
        }}
      >
        <text
          style={{
            fontSize: 12.5,
            lineHeight: 18,
            color: running ? C.text : C.tertiary,
            fontWeight: running ? 600 : 400,
          }}
        >
          {duration}
        </text>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} color={C.ghost} />
      </div>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(tools ?? []).map((tool) => (
            <div
              key={tool.name}
              style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <div
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  flexShrink: 0,
                  backgroundColor:
                    tool.status === 'done' ? C.success : tool.status === 'error' ? C.error : C.tertiary,
                }}
              />
              <text style={{ fontSize: 13, lineHeight: 18, color: C.secondary, flexShrink: 0 }}>{tool.name}</text>
              {/* The arguments are what make a collapsed tool row legible: a
                  bare "bash" says nothing about what ran. */}
              {tool.args && (
                <text
                  style={{
                    fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 18, color: C.muted,
                    flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                  }}
                >
                  {tool.args}
                </text>
              )}
            </div>
          ))}
          {(tools ?? []).length === 0 && (
            <text style={{ fontSize: 13, lineHeight: 18, color: C.tertiary }}>
              Answered without tool calls.
            </text>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The label on a turn's tool fold.
 *
 * A reloaded transcript has no timestamps, so the elapsed time is unknown —
 * not zero. Saying "Worked for 0 seconds" there was a fabricated measurement,
 * and worse, it appeared after every individual call. The count is the fact
 * that is actually known.
 */
export function activityDuration(activities: readonly ToolActivity[]): string {
  if (activities.length === 0) return 'Worked'
  if (activities.some((a) => a.status === 'running')) return 'Working…'
  const timed = activities.filter((a) => a.createdAt !== undefined && a.endedAt !== undefined)
  if (timed.length === 0) {
    const n = activities.length
    return `${n} tool call${n === 1 ? '' : 's'}`
  }
  const start = Math.min(...timed.map((a) => a.createdAt!))
  const end = Math.max(...timed.map((a) => a.endedAt!))
  // formatDuration already carries the "Worked for" wording; prefixing it here
  // again produced "Worked for Worked for 9 seconds".
  return formatDuration(Math.max(0, end - start))
}

/**
 * The fold's label, preferring the engine's own turn span over tool timings.
 *
 * The span between `turn_start` and `turn_end` covers the parts a tool-timing
 * sum misses: the model thinking before the first call, and the writing after
 * the last one. A turn the user interrupted is labelled as such — it is not a
 * failure, and "Worked for…" would claim a completion that did not happen.
 * Falls back to the tool timings when no ledger entry exists, which is the case
 * for a reloaded transcript.
 */
export function turnDurationLabel(
  record: TurnRecord | undefined,
  activities: readonly ToolActivity[],
): string {
  if (record?.state === 'interrupted') return 'Interrupted'
  if (record?.state === 'running') return 'Working…'
  if (record && record.endedAt !== undefined) {
    return formatDuration(Math.max(0, record.endedAt - record.startedAt))
  }
  return activityDuration(activities)
}

const ROW_INNER_STYLE = { width: CONTENT_MAX_WIDTH, maxWidth: '100%' } as const
const ROW_STYLE = {
  display: 'flex',
  flexDirection: 'row',
  justifyContent: 'center',
  width: '100%',
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: 20,
  paddingRight: 20,
} as const
const ROW_STYLE_FIRST = { ...ROW_STYLE, paddingTop: 22 } as const
const ROW_STYLE_LAST = { ...ROW_STYLE, paddingBottom: 22 } as const
const ROW_STYLE_ONLY = { ...ROW_STYLE, paddingTop: 22, paddingBottom: 22 } as const

function TranscriptRow({
  children,
  first,
  last,
}: {
  children: React.ReactNode
  first?: boolean
  last?: boolean
}) {
  const style = first && last ? ROW_STYLE_ONLY : first ? ROW_STYLE_FIRST : last ? ROW_STYLE_LAST : ROW_STYLE
  return (
    <div style={style}>
      <div style={ROW_INNER_STYLE}>{children}</div>
    </div>
  )
}

const CODE_CARD_STYLE: StyleDesc = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  minWidth: 0,
  borderRadius: 10,
  borderWidth: 1,
  borderColor: C.border,
  backgroundColor: '#FFFFFF09',
  overflow: 'hidden',
}
const CODE_HEADER_STYLE: StyleDesc = {
  paddingLeft: 12,
  paddingRight: 12,
  paddingTop: 5,
  paddingBottom: 5,
}
const CODE_BODY_STYLE = {
  minWidth: 0,
  paddingLeft: 12,
  paddingRight: 12,
  paddingTop: 10,
  paddingBottom: 10,
} as const

/**
 * A copy control that confirms in place.
 *
 * There is no clipboard API in GPUIX, the shell, or the DOM, so the engine
 * owns the write; this only reports that it happened. The label reverts on its
 * own rather than waiting for a click elsewhere, so a stale "Copied" never
 * claims something is still on the clipboard.
 */
function CopyButton({
  text,
  label,
  testId,
  onCopy,
}: {
  text: string
  label?: string
  testId?: string
  /** Resolves once the clipboard write actually lands; rejects if it did not. */
  onCopy: (text: string) => Promise<void>
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const press = () => {
    // The label follows the write, not the click. Announcing "Copied" while the
    // engine is down — which is exactly what a stale engine produces — is the
    // one thing a copy control must never do.
    void onCopy(text).then(
      () => setState('copied'),
      () => setState('failed'),
    )
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1800)
  }
  const copied = state === 'copied'
  const failed = state === 'failed'
  return (
    <div
      testId={testId}
      role="button"
      tabIndex={0}
      // Icon only, so the accessible name is what a sighted user reads on
      // hover. A glyph with no name is invisible to a screen reader.
      aria-label={failed ? `Copy ${label ?? ''} failed` : copied ? 'Copied' : `Copy ${label ?? ''}`}
      onClick={press}
      onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') press() }}
      style={{
        display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 20, borderRadius: 5,
        cursor: 'pointer', flexShrink: 0,
        hover: { backgroundColor: C.overlay },
      }}
    >
      <Icon
        name={copied ? 'check' : 'copy'}
        size={12}
        color={copied ? C.success : failed ? C.error : C.ghost}
      />
    </div>
  )
}

/** One ANSI-styled run. GPUIX has no inline span, so each run is a <text>. */
const ANSI_RUN_STYLE = {
  fontFamily: FONT_MONO,
  fontSize: 12.5,
  lineHeight: 20,
  color: C.secondary,
  whiteSpace: 'nowrap' as const,
}

/**
 * The card `<code>` used to paint for you. The native element is a bare
 * surface now, so the roundness, the fill and the language header live here,
 * in app code, where they can match the rest of the design.
 */
/** One styled run of text produced by parsing ANSI escapes. */
export type AnsiRun = {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
}

/**
 * The 8 base ANSI colours, mapped onto Escape's palette rather than invented.
 *
 * Terminal output that reaches the chat surface arrives as raw SGR escapes. The
 * model produced `\x1b[1;97m` when asked for colour, and with no renderer those
 * bytes print literally — the user sees escape codes instead of colour. Mapping
 * onto the app's own tokens keeps terminal output looking like the app rather
 * than like a pasted ANSI dump.
 */
const ANSI_BASE: Record<number, string> = {
  30: '#5A5750', // black   -> ghost
  31: C.error,   // red
  32: C.success, // green
  33: C.warning, // yellow
  34: '#7FA9D6', // blue
  35: '#C89BD8', // magenta
  36: '#6FC3C0', // cyan
  37: C.secondary, // white
  90: '#7A766C', // bright black
  91: '#F5A0A0',
  92: '#8FE8BE',
  93: '#F3D49B',
  94: '#9FC2E8',
  95: '#DDBCE8',
  96: '#96DEDB',
  97: '#D8D3C8', // bright white
}

/**
 * Parses SGR escape sequences into styled runs.
 *
 * Only SGR (`ESC [ … m`) is interpreted; every other escape is dropped rather
 * than printed, because a cursor-move or erase sequence shown as text is noise
 * too. The 256-colour and truecolour forms are approximated onto the palette —
 * this is a chat transcript, not a terminal emulator, and exact fidelity is not
 * the point. `38;5;n` picks from a small ramp, `38;2;r;g;b` is blended onto the
 * canvas so light and dark text both stay readable.
 */
/**
 * Normalises the two shapes a model emits escapes in: a real ESC byte, and the
 * literal text "x1b[1;97m" left behind when something upstream escaped it. Both
 * occur in real transcripts; the second paints as visible garbage, which is the
 * whole complaint, so it is folded into the first before anything reads offsets.
 */
export function normalizeAnsi(input: string): string {
  if (input.includes('\u001b')) return input
  // Both `x1b[1;97m` and `\x1b[1;97m` occur: the first when the backslash was
  // eaten in transit, the second when a shell tool echoed it. Both mean ESC.
  return input.replace(/(?:\\)?x1b(?=\[[0-9;]*m)/g, '\u001b')
}

/** True when a source carries escapes in either shape. */
export function hasAnsi(input: string): boolean {
  return normalizeAnsi(input).includes('\u001b')
}

export function parseAnsi(input: string): AnsiRun[] {
  const source = normalizeAnsi(input)

  // A source with no escape at all is by far the common case; skip the work.
  if (!source.includes('\u001b')) return [{ text: input }]

  const runs: AnsiRun[] = []
  let current: Omit<AnsiRun, 'text'> = {}
  let text = ''
  const flush = () => {
    if (text) runs.push({ text, ...current })
    text = ''
  }

  const pattern = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[A-Za-z]/g
  let last = 0
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    text += source.slice(last, m.index)
    last = pattern.lastIndex
    // Non-SGR escape: dropped, not painted.
    if (!m[1] && !m[0].endsWith('m')) {
      flush()
      continue
    }
    flush()
    const codes = (m[1] ?? '0').split(';').map((v) => (v === '' ? 0 : Number(v)))
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!
      if (code === 0) current = {}
      else if (code === 1) current.bold = true
      else if (code === 2) current.dim = true
      else if (code === 22) { current.bold = false; current.dim = false }
      else if (code === 39) delete current.color
      else if (ANSI_BASE[code]) current.color = ANSI_BASE[code]
      else if (code === 38) {
        const mode = codes[i + 1]
        if (mode === 5) {
          const n = codes[i + 2] ?? 0
          if (n >= 0 && n <= 7) current.color = ANSI_BASE[30 + n]!
          else if (n >= 232 && n <= 255) current.color = greyscale(n - 232)
          else current.color = ramp(n)
          i += 2
        } else if (mode === 2) {
          const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0]
          current.color = mixWithCanvas(r, g, b)
          i += 4
        }
      } else if (code === 39 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        // Background colours are ignored: the code block has its own surface.
      }
    }
  }
  text += source.slice(last)
  flush()
  return runs
}

function greyscale(step: number): string {
  const v = Math.round(88 + (step / 23) * 127)
  const hex = v.toString(16).padStart(2, '0')
  return `#${hex}${hex}${hex}`
}

/** The 6×6×6 colour cube of the 256-colour palette, approximated. */
function ramp(n: number): string {
  if (n < 16) return ANSI_BASE[n < 8 ? 30 + n : 82 + (n - 8)] ?? C.secondary
  if (n >= 16 && n <= 231) {
    const i = n - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const r = steps[Math.floor(i / 36) % 6]!
    const g = steps[Math.floor(i / 6) % 6]!
    const b = steps[i % 6]!
    return mixWithCanvas(r, g, b)
  }
  return greyscale(n - 232)
}

/**
 * Pulls a colour toward the code surface so truecolour text stays legible on
 * both themes rather than fighting them.
 */
function mixWithCanvas(r: number, g: number, b: number): string {
  const mix = (v: number, surface: number) => Math.round(v * 0.82 + surface * 0.18)
  const hex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')
  return `#${hex(mix(r, 0x1c))}${hex(mix(g, 0x19))}${hex(mix(b, 0x16))}`
}

/**
 * Slices the parsed runs down to one source line.
 *
 * The runs are produced for the whole source, but the renderer draws line by
 * line. Style carries across a newline — a colour set on line 1 still applies
 * on line 2 — so a run is allowed to span lines and is split here.
 */
function runsForLine(runs: AnsiRun[], source: string, row: number): AnsiRun[] {
  const start = lineStartOffset(source, row)
  const end = lineEndOffset(source, row)
  const out: AnsiRun[] = []
  let cursor = 0
  for (const run of runs) {
    const runStart = cursor
    const runEnd = cursor + run.text.length
    cursor = runEnd
    if (runEnd <= start || runStart >= end) continue
    const from = Math.max(start, runStart) - runStart
    const to = Math.min(end, runEnd) - runStart
    out.push({ ...run, text: run.text.slice(from, to) })
  }
  return out
}

function lineStartOffset(source: string, row: number): number {
  let offset = 0
  for (let i = 0; i < row; i++) {
    const next = source.indexOf('\n', offset)
    if (next === -1) return source.length
    offset = next + 1
  }
  return offset
}

function lineEndOffset(source: string, row: number): number {
  const start = lineStartOffset(source, row)
  const next = source.indexOf('\n', start)
  return next === -1 ? source.length : next
}

function CodeBlock({
  code,
  language,
  showLineNumbers,
  onCopy,
}: {
  code: string
  language?: string
  showLineNumbers?: boolean
  onCopy: (text: string) => Promise<void>
}) {
  return (
    <div style={CODE_CARD_STYLE}>
      {/* The header carries the language and the copy control. It renders even
          for a block with no language, because copy is useful either way. */}
      <div
        style={{
          ...CODE_HEADER_STYLE,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <text style={{ fontSize: 12, color: C.secondary, flexGrow: 1, minWidth: 0 }}>
          {language ?? 'code'}
        </text>
        <CopyButton text={code} label="code" testId="copy-code" onCopy={onCopy} />
      </div>
      {(() => {
        // Terminal output carries its own colour as SGR escapes. Passing that
        // to <code> paints the escapes literally, because they are not
        // language tokens. Those sources are rendered as styled runs instead.
        if (!hasAnsi(code)) {
          return (
            <code
              code={code}
              language={language}
              showLineNumbers={showLineNumbers}
              theme={currentTheme()}
              style={CODE_BODY_STYLE}
            />
          )
        }
        // Offsets below refer to the normalised text, so both must agree.
        const normalized = normalizeAnsi(code)
        const runs = parseAnsi(code)
        return (
          <div
            testId="ansi-code"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              ...CODE_BODY_STYLE,
              width: '100%',
            }}
          >
            {code.split('\n').map((_line, row) => {
              // Runs are produced for the whole source; take this line's slice.
              const lineRuns = runsForLine(runs, normalized, row)
              return (
                <div key={row} style={{ display: 'flex', flexDirection: 'row', gap: 10, minWidth: 0 }}>
                  {showLineNumbers && (
                    <text style={{ fontSize: 11, color: C.muted, flexShrink: 0, minWidth: 20, textAlign: 'right' }}>
                      {String(row + 1)}
                    </text>
                  )}
                  {/* GPUIX has no <span>. A styled run is a sibling <text>
                      node carrying its own colour, laid out in a row. */}
                  <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, gap: 0 }}>
                    {lineRuns.length === 0 ? (
                      <text style={ANSI_RUN_STYLE}> </text>
                    ) : (
                      lineRuns.map((run, i) => (
                        <text
                          key={i}
                          style={{
                            ...ANSI_RUN_STYLE,
                            color: run.color,
                            fontWeight: run.bold ? 700 : 400,
                            opacity: run.dim ? 0.72 : 1,
                          }}
                        >
                          {run.text}
                        </text>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}

/** A modal card. Dialog owns Escape, the backdrop press, the Tab trap, and
 *  moving focus in on open and back out on close. */
function OverlayCard({
  title,
  open,
  onClose,
  children,
  height,
  width,
  bare,
  initialFocus,
}: {
  title: string
  open: boolean
  onClose: () => void
  children: React.ReactNode
  height?: number
  width?: number
  /**
   * Drops the title row and the Close button. A dialog that is a search field
   * with results under it does not need a heading saying so, and a Close text
   * button in the corner is the detail that makes a panel read as a 2005
   * dialog. Escape and the backdrop already close it.
   */
  bare?: boolean
  initialFocus?: React.RefObject<PublicInstance | null>
}) {
  return (
    <Dialog open={open} onOpenChange={(next: boolean) => !next && onClose()}>
      <DialogPortal>
        <DialogBackdrop style={{ backgroundColor: '#00000066' }} />
        <DialogPopup
          initialFocus={initialFocus}
          // A dialog with no name is announced as just "dialog". A bare panel
          // drops the visible title, so the name has to be carried by an
          // attribute instead of by the text that used to be there.
          aria-label={bare ? title : undefined}
          style={{
            width: width ?? 420,
            height,
            maxWidth: '90%',
            backgroundColor: C.raised,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: C.borderStrong,
            padding: bare ? 0 : 16,
            display: 'flex',
            flexDirection: 'column',
            gap: bare ? 0 : 12,
            overflow: 'hidden',
          }}
        >
          {/* A dialog appearing out of nothing is the most jarring pop in the
              app, and it is the one place a fade earns its keep: it says
              "something is here now" without moving anything, so nothing has to
              be re-laid-out mid-read.

              Opacity only, and that is not a stylistic choice. GPUIX animates
              opacity and also position and size, but position and size are
              layout properties, so opacity is the only one available here that
              does not cost a relayout. See motion.ts. */}
          <motion.div
            {...fadeIn(DURATION.overlay)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: bare ? 0 : 12,
              flexGrow: 1,
              minHeight: 0,
            }}
          >
          {bare ? null : (
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
            <DialogTitle style={{ flexGrow: 1 }}>
              <text style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</text>
            </DialogTitle>
            <DialogClose
              testId="overlay-close"
              style={{
                height: 24,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                hover: { backgroundColor: C.overlay },
              }}
            >
              <text style={{ fontSize: 12, color: C.secondary }}>Close</text>
            </DialogClose>
          </div>
          )}
          {children}
          </motion.div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  )
}

export interface SettingsState {
  theme: ThemeId
  sansId: string
  monoId: string
  sansSize: number
  monoSize: number
  typographyAdvanced: boolean
  lineHeight: LineHeightMode
  wordWrap: boolean
  diffFileState: 'expanded' | 'collapsed'
  diffLayout: 'stacked' | 'side-by-side'
  // t3code-inspired git integration — local only, like Workspace/Submodules in t3code's General
  workspaceMode: 'current' | 'worktree'
  submoduleMode: 'recursive' | 'shallow'
  gitAutoFetch: boolean
}

export const DEFAULT_SETTINGS: SettingsState = {
  theme: 'dark',
  sansId: 'SF Pro',
  monoId: 'Menlo',
  sansSize: 15,
  monoSize: 13,
  typographyAdvanced: false,
  lineHeight: 'comfortable',
  wordWrap: false,
  diffFileState: 'expanded',
  diffLayout: 'stacked',
  workspaceMode: 'current',
  submoduleMode: 'recursive',
  gitAutoFetch: true,
}

function SettingsSelect({
  value,
  onChange,
  items,
  testId,
  ariaLabel,
  menuWidth,
}: {
  value: string
  onChange: (next: string) => void
  items: { value: string; label: string; description?: string }[]
  testId?: string
  ariaLabel?: string
  menuWidth?: number
}) {
  const selected = items.find((item) => item.value === value) ?? items[0]!
  return (
    <Select items={items} value={value} onValueChange={onChange} style={{ flexShrink: 0 }}>
      <div style={{ position: 'relative', display: 'flex' }}>
        <SelectTrigger
          testId={testId}
          aria-label={ariaLabel ?? selected.label}
          style={(state) => ({
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 30,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: C.borderStrong,
            cursor: 'pointer',
            backgroundColor: state.open ? C.overlay : '#00000000',
            hover: { backgroundColor: C.overlay },
          })}
        >
          <text
            style={{
              fontSize: 13,
              lineHeight: 16,
              color: C.secondary,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {selected.label}
          </text>
          <Icon name="chevronDown" size={10.5} color={C.ghost} />
        </SelectTrigger>
        <SelectContent side="bottom" sideOffset={4} style={{ ...MENU, minWidth: menuWidth ?? 220 }}>
          {items.map((item) => (
            <SelectItem
              asChild
              key={item.value}
              value={item.value}
              testId={testId ? `${testId}-${item.value}` : undefined}
              style={(state) => menuItemStyle(state)}
            >
              {(state) => (
                <MenuRow
                  label={item.label}
                  description={item.description}
                  selected={state.selected}
                />
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </div>
    </Select>
  )
}

/** Max rows painted before the list asks for a narrower query. */
const FONT_TABLE_LIMIT = 120

export function FilterSelect({
  value,
  onChange,
  items,
  testId,
  ariaLabel,
  menuWidth,
}: {
  value: string
  onChange: (next: string) => void
  items: FontOption[]
  testId?: string
  ariaLabel?: string
  menuWidth?: number
}) {
  const [query, setQuery] = useState('')
  const selected = items.find((item) => item.id === value) ?? items[0]
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return items
    return items.filter((item) => item.label.toLowerCase().includes(q))
  }, [items, query])
  const shown = filtered.slice(0, FONT_TABLE_LIMIT)
  return (
    <Select
      items={items.map((item) => ({ value: item.id, label: item.label }))}
      value={value}
      onValueChange={onChange}
      onOpenChange={(open) => {
        if (open) setQuery('')
      }}
      style={{ flexShrink: 0 }}
    >
      <div style={{ position: 'relative', display: 'flex' }}>
        <SelectTrigger
          testId={testId}
          aria-label={ariaLabel ?? selected?.label ?? 'Font'}
          style={(state) => ({
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            height: 30,
            paddingLeft: 10,
            paddingRight: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: C.borderStrong,
            cursor: 'pointer',
            backgroundColor: state.open ? C.overlay : '#00000000',
            hover: { backgroundColor: C.overlay },
          })}
        >
          <text
            style={{
              fontSize: 13,
              lineHeight: 16,
              color: C.secondary,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {selected?.label ?? 'Font'}
          </text>
          <Icon name="chevronDown" size={10.5} color={C.ghost} />
        </SelectTrigger>
        <SelectContent
          side="bottom"
          sideOffset={4}
          testId={testId ? `${testId}-menu` : undefined}
          style={{
            ...MENU,
            minWidth: menuWidth ?? 280,
            maxHeight: 340,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          <input
            testId={testId ? `${testId}-search` : undefined}
            aria-label="Filter fonts"
            value={query}
            placeholder="Filter fonts"
            theme={{ caret: C.accent, text: C.text, textMuted: C.muted }}
            style={{
              width: '100%',
              height: 30,
              flexShrink: 0,
              fontSize: 13,
              fontFamily: FONT_SANS,
              color: C.text,
              backgroundColor: C.composer,
              borderWidth: 1,
              borderColor: C.border,
              borderRadius: 7,
              paddingLeft: 8,
              paddingRight: 8,
              marginBottom: 4,
            }}
            onChange={(event) => setQuery(event.value ?? '')}
          />
          <div
            testId={testId ? `${testId}-list` : undefined}
            style={{
              display: 'flex',
              flexDirection: 'column',
              flexGrow: 1,
              minHeight: 0,
              overflowY: 'scroll',
            }}
          >
            {shown.map((item) => (
              <SelectItem
                asChild
                key={item.id}
                value={item.id}
                testId={testId ? `${testId}-option-${item.id}` : undefined}
                style={(state) => menuItemStyle(state)}
              >
                {(state) => (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      paddingTop: 5,
                      paddingBottom: 5,
                      paddingLeft: 8,
                      paddingRight: 8,
                    }}
                  >
                    <text
                      style={{
                        fontSize: 13,
                        fontFamily: item.family,
                        color: C.text,
                        flexGrow: 1,
                        minWidth: 0,
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {item.label}
                    </text>
                    {state.selected && <Icon name="check" size={11} color={C.tertiary} />}
                  </div>
                )}
              </SelectItem>
            ))}
            {shown.length === 0 && (
              <text style={{ fontSize: 12.5, color: C.muted, paddingLeft: 8, paddingTop: 6 }}>
                No fonts match
              </text>
            )}
          </div>
          <text style={{ fontSize: 11, color: C.muted, paddingLeft: 8, paddingTop: 4 }}>
            {filtered.length <= FONT_TABLE_LIMIT
              ? `${filtered.length} of ${items.length}`
              : `${filtered.length} of ${items.length} — keep typing to narrow`}
          </text>
        </SelectContent>
      </div>
    </Select>
  )
}

function Switch({
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
      onKeyDown={(event: { key?: string }) => {
        if (event.key === 'enter' || event.key === ' ') onChange(!checked)
      }}
      style={{
        width: 40,
        height: 24,
        flexShrink: 0,
        borderRadius: 12,
        cursor: 'pointer',
        backgroundColor: checked ? '#3B82F6' : C.overlayStrong,
      }}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          marginTop: 3,
          marginLeft: checked ? 19 : 3,
          backgroundColor: '#E7E9EC',
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}

/** A compact labelled button, for a row whose control is an action. */
function SettingsActionButton({
  testId,
  label,
  onClick,
}: {
  testId: string
  label: string
  onClick: () => void
}) {
  return (
    <Button
      testId={testId}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        height: 24,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 6,
        cursor: 'pointer',
        backgroundColor: C.item,
        hover: { backgroundColor: C.overlay },
      }}
    >
      <text style={{ fontSize: 12, color: C.secondary }}>{label}</text>
    </Button>
  )
}

function SettingsRow({
  label,
  description,
  control,
  last,
}: {
  label: string
  description?: string
  control: React.ReactNode
  last?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: 16,
        paddingTop: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        paddingRight: 16,
        borderBottomWidth: last ? 0 : 1,
        borderColor: C.border,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: 0,
          gap: 4,
          justifyContent: 'center',
        }}
      >
        <text style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{label}</text>
        {description && (
          <text style={{ fontSize: 13, lineHeight: 18, color: C.secondary }}>{description}</text>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{control}</div>
    </div>
  )
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        backgroundColor: C.raised,
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: 12,
        overflow: 'hidden',
        // Subtle warm tint so cards lift off the canvas
        background: C.raised,
      }}
    >
      {children}
    </div>
  )
}

function SettingsGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <text
      style={{
        fontSize: 13,
        fontWeight: 500,
        color: C.secondary,
        paddingBottom: 8,
        paddingTop: 24,
      }}
    >
      {children}
    </text>
  )
}

function SettingsTextInput({
  value,
  onChange,
  placeholder,
  testId,
  width,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  testId?: string
  width?: number
}) {
  return (
    <input
      testId={testId}
      value={value}
      placeholder={placeholder}
      theme={{ caret: C.accent, text: C.text, textMuted: C.muted }}
      style={{
        width: width ?? 200,
        height: 32,
        flexShrink: 0,
        fontSize: 13,
        fontFamily: FONT_SANS,
        color: C.text,
        backgroundColor: C.composer,
        borderWidth: 1,
        borderColor: C.border,
        borderRadius: 8,
        paddingLeft: 10,
        paddingRight: 10,
      }}
      onChange={(event) => onChange(event.value ?? '')}
    />
  )
}

function SettingsButton({
  label,
  onClick,
  testId,
  danger,
}: {
  label: string
  onClick: () => void
  testId?: string
  danger?: boolean
}) {
  return (
    <Button
      testId={testId}
      aria-label={label}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        flexShrink: 0,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.borderStrong,
        cursor: 'pointer',
        hover: { backgroundColor: C.overlay },
        active: { backgroundColor: C.overlayStrong },
      }}
    >
      <text style={{ fontSize: 13, fontWeight: 500, color: danger ? C.error : C.secondary }}>
        {label}
      </text>
    </Button>
  )
}

function ProviderStatus({ connected }: { connected: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          flexShrink: 0,
          backgroundColor: connected ? C.success : C.ghost,
        }}
      />
      <text style={{ fontSize: 13, color: C.secondary }}>{connected ? 'Connected' : 'Not connected'}</text>
    </div>
  )
}

type SettingsSectionId = 'general' | 'appearance' | 'providers' | 'source'

const SAMPLE_DIFF_PATCH = [
  'diff --git a/src/formatUser.ts b/src/formatUser.ts',
  'index 111..222 100644',
  '--- a/src/formatUser.ts',
  '+++ b/src/formatUser.ts',
  '@@ -1,3 +1,3 @@',
  ' export function formatUser(user: User) {',
  '-  return user.name.toUpperCase();',
  '+  return displayName(user);',
  ' }',
].join('\n')

const SAMPLE_TERMINAL = [
  'VITE v7.1.1  ready in 1.24s',
  '',
  '  85 passed    2 warnings    0 failed',
  '',
  'READY  watching for changes',
].join('\n')

const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'sliders' },
  { id: 'appearance', label: 'Appearance', icon: 'sparkle' },
  { id: 'providers', label: 'Providers', icon: 'cpu' },
  { id: 'source', label: 'Source Control', icon: 'gitBranch' },
]

function SettingsScreen({
  settings,
  onChange,
  onClose,
  models,
  providers,
  defaultProvider,
  onDefaultProvider,
  apiBaseURL,
  providerError,
  onRefreshProviders,
  onSaveKey,
  onRemoveKey,
  onSaveEndpoint,
  followUp,
  onFollowUp,
  textModel,
  onTextModel,
  sansOptions,
  monoOptions,
  gitBranch,
  gitDirty,
  onRefreshGit,
  onOpenDiff,
  startDir,
  onStartDir,
  startDirError,
}: {
  settings: SettingsState
  onChange: (patch: Partial<SettingsState>) => void
  onClose: () => void
  models: ModelInfo[]
  providers: ProviderSummary[]
  defaultProvider: string
  onDefaultProvider: (id: string) => void
  apiBaseURL: string
  providerError: string
  onRefreshProviders: () => void
  onSaveKey: (provider: 'opencode-go' | 'opencode-zen', key: string) => void
  onRemoveKey: (provider: 'opencode-go' | 'opencode-zen' | 'api') => void
  onSaveEndpoint: (baseURL: string, key: string) => void
  followUp: 'queue' | 'steer'
  onFollowUp: (next: 'queue' | 'steer') => void
  textModel: string
  onTextModel: (next: string) => void
  sansOptions: FontOption[]
  monoOptions: FontOption[]
  gitBranch: string
  gitDirty: number
  onRefreshGit: () => void
  onOpenDiff: () => void
  startDir: string
  onStartDir: (next: string) => void
  startDirError: string
}) {
  const [section, setSection] = useState<SettingsSectionId>('general')
  const [lastStartDir, setLastStartDir] = useState(startDir)
  const [query, setQuery] = useState('')
  const [goKey, setGoKey] = useState('')
  const [zenKey, setZenKey] = useState('')
  // "~" for the home folder, so a value under the home directory reads as the
  // short form a person would type. It is a display form only: what gets written
  // is the expanded path, and the engine expands a tilde on the way in.
  const homeDir = os.homedir()
  const displayStartDir = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed === '') return '~/'
    if (trimmed === homeDir) return '~/'
    if (trimmed.startsWith(homeDir + '/')) return '~' + trimmed.slice(homeDir.length)
    return trimmed
  }
  // The draft is the real value, so it starts empty at the default. Putting "~/"
  // in the value instead would mean typing appended to it.
  const [startDraft, setStartDraft] = useState(startDir)
  const [epUrl, setEpUrl] = useState('')
  const [epKey, setEpKey] = useState('')
  // A value that changed underneath, from the engine applying it or from a reset
  // elsewhere, replaces the draft. Otherwise the field would show a directory
  // that is no longer the one in force.
  if (startDir !== lastStartDir) {
    setLastStartDir(startDir)
    setStartDraft(startDir)
  }
  const activeLabel = SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? section
  const q = query.trim().toLowerCase()
  const match = (label: string, description?: string) =>
    q === '' || `${label} ${description ?? ''}`.toLowerCase().includes(q)
  const textModelItems = [
    { value: '', label: 'Same as chat model' },
    ...models.map((m) => ({ value: m.id, label: m.name ?? m.id })),
  ]
  const providerStatus = (id: string) =>
    providers.find((p) => p.id === id)?.configured ?? false
  const sansFamily =
    sansOptions.find((f) => f.id === settings.sansId)?.family ??
    sansOptions[0]?.family ??
    SANS_FONTS[0]!.family
  const monoFamily =
    monoOptions.find((f) => f.id === settings.monoId)?.family ??
    monoOptions[0]?.family ??
    MONO_FONTS[0]!.family

  return (
    <div
      testId="settings-screen"
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        backgroundColor: C.canvas,
        fontFamily: FONT_SANS,
        color: C.text,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 232,
          flexShrink: 0,
          height: '100%',
          backgroundColor: C.sidebar,
          borderRightWidth: 1,
          borderColor: C.sidebarBorder,
          paddingTop: TITLEBAR_HEIGHT,
          paddingLeft: 10,
          paddingRight: 10,
          paddingBottom: 10,
          userSelect: 'none',
        }}
      >
        <input
          testId="settings-search"
          aria-label="Search settings"
          value={query}
          placeholder="Search"
          theme={{ caret: C.accent, text: C.text, textMuted: C.muted }}
          style={{
            width: '100%',
            height: 32,
            flexShrink: 0,
            fontSize: 13,
            fontFamily: FONT_SANS,
            color: C.text,
            backgroundColor: C.composer,
            borderWidth: 1,
            borderColor: C.border,
            borderRadius: 8,
            paddingLeft: 10,
            paddingRight: 10,
            marginBottom: 8,
          }}
          onChange={(event) => setQuery(event.value ?? '')}
        />
        {SETTINGS_SECTIONS.map((item) => {
          const active = item.id === section
          return (
            <Button
              key={item.id}
              testId={`settings-nav-${item.id}`}
              aria-label={item.label}
              onClick={() => setSection(item.id)}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                height: 32,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 7,
                marginBottom: 2,
                cursor: 'pointer',
                backgroundColor: active ? C.item : '#00000000',
                hover: { backgroundColor: C.item },
              }}
            >
              <Icon name={item.icon} size={14} color={active ? C.text : C.secondary} />
              <text
                style={{
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  color: active ? C.text : C.secondary,
                }}
              >
                {item.label}
              </text>
            </Button>
          )
        })}
        <div style={{ flexGrow: 1 }} />
        <Button
          testId="settings-back"
          aria-label="Back to chat"
          onClick={onClose}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            height: 32,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 7,
            cursor: 'pointer',
            hover: { backgroundColor: C.item },
          }}
        >
          <Icon name="arrowLeft" size={14} color={C.secondary} />
          <text style={{ fontSize: 13, color: C.secondary }}>Back</text>
        </Button>
      </div>
      <div
        testId="settings-content"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: 0,
          height: '100%',
          overflowY: 'scroll',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            maxWidth: 900,
            paddingLeft: 32,
            paddingRight: 32,
            paddingTop: 24,
            paddingBottom: 48,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              height: 32,
              flexShrink: 0,
            }}
          >
            <text style={{ fontSize: 13, color: C.tertiary }}>Settings</text>
            <text style={{ fontSize: 13, color: C.muted }}>/</text>
            <text testId="settings-breadcrumb" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
              {activeLabel}
            </text>
            <div style={{ flexGrow: 1 }} />
            <Button
              testId="settings-restore"
              aria-label="Restore defaults"
              onClick={() => onChange({ ...DEFAULT_SETTINGS })}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                height: 28,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 7,
                cursor: 'pointer',
                hover: { backgroundColor: C.item },
              }}
            >
              <Icon name="retry" size={12} color={C.tertiary} />
              <text style={{ fontSize: 13, color: C.tertiary }}>Restore defaults</text>
            </Button>
          </div>
          {section === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <SettingsGroupLabel>Startup</SettingsGroupLabel>
              <SettingsCard>
                {match('Starting directory', 'where a session opens') && (
                  <SettingsRow
                    label="Starting directory"
                    description={`A session opens in ${displayStartDir(startDir)} when the app is launched.`}
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          width: 300,
                        }}
                      >
                        <input
                          testId="settings-start-dir"
                          value={startDraft}
                          placeholder="~/"
                          aria-label="Starting directory"
                          theme={currentTheme()}
                          onChange={(event) => setStartDraft(event.value ?? '')}
                          onSubmit={() => onStartDir(startDraft)}
                          style={{
                            flexGrow: 1,
                            minWidth: 0,
                            height: 28,
                            fontSize: 12,
                            color: C.text,
                            backgroundColor: '#00000000',
                            borderWidth: 0,
                          }}
                        />
                        <SettingsActionButton
                          testId="settings-start-dir-apply"
                          label="Set"
                          onClick={() => onStartDir(startDraft)}
                        />
                        {startDir !== '' && (
                          <SettingsActionButton
                            testId="settings-start-dir-clear"
                            label="Clear"
                            onClick={() => {
                              setStartDraft('')
                              onStartDir('')
                            }}
                          />
                        )}
                      </div>
                    }
                  />
                )}
                {startDirError !== '' && (
                  <text
                    testId="settings-start-dir-error"
                    role="alert"
                    style={{ fontSize: 12, color: C.error, paddingLeft: 16, paddingBottom: 12 }}
                  >
                    {startDirError}
                  </text>
                )}
              </SettingsCard>
              <SettingsGroupLabel>Diffs</SettingsGroupLabel>
              <SettingsCard>
                {match('Default diff file state', 'expanded or collapsed') && (
                  <SettingsRow
                    label="Default diff file state"
                    description="Start with files expanded or collapsed when opening diffs or a pull request's Code tab."
                    control={
                      <SettingsSelect
                        testId="settings-diff-file-state"
                        value={settings.diffFileState}
                        onChange={(next) =>
                          onChange({ diffFileState: next as SettingsState['diffFileState'] })
                        }
                        items={[
                          { value: 'expanded', label: 'Expanded' },
                          { value: 'collapsed', label: 'Collapsed' },
                        ]}
                      />
                    }
                  />
                )}
                {match('Diff layout', 'stacked or side by side') && (
                  <SettingsRow
                    label="Diff layout"
                    description="Show diffs stacked or side by side. The toggle in the diff toolbar changes this too."
                    last
                    control={
                      <SettingsSelect
                        testId="settings-diff-layout"
                        value={settings.diffLayout}
                        onChange={(next) =>
                          onChange({ diffLayout: next as SettingsState['diffLayout'] })
                        }
                        items={[
                          { value: 'stacked', label: 'Stacked' },
                          { value: 'side-by-side', label: 'Side by side' },
                        ]}
                      />
                    }
                  />
                )}
              </SettingsCard>
              <SettingsGroupLabel>Behavior</SettingsGroupLabel>
              <SettingsCard>
                {match('Follow-up behavior', 'queue follow-ups') && (
                  <SettingsRow
                    label="Follow-up behavior"
                    description="Queue follow-ups while the agent runs or steer the current run. Press ⌘ + Enter to do the opposite for one message."
                    control={
                      <SettingsSelect
                        testId="settings-follow-up"
                        value={followUp}
                        onChange={(next) => onFollowUp(next as 'queue' | 'steer')}
                        items={[
                          { value: 'queue', label: 'Queue follow-ups' },
                          { value: 'steer', label: 'Steer the run' },
                        ]}
                        menuWidth={240}
                      />
                    }
                  />
                )}
                {match('Text generation model', 'thread titles') && (
                  <SettingsRow
                    label="Text generation model"
                    description="Used for thread titles and other generated text."
                    last
                    control={
                      <SettingsSelect
                        testId="settings-text-model"
                        value={textModel}
                        onChange={onTextModel}
                        items={textModelItems}
                        menuWidth={260}
                      />
                    }
                  />
                )}
              </SettingsCard>
              {q !== '' &&
                !match('Default diff file state', 'expanded or collapsed') &&
                !match('Diff layout', 'stacked or side by side') &&
                !match('Follow-up behavior', 'queue follow-ups') &&
                !match('Text generation model', 'thread titles') && (
                  <text
                    testId="settings-empty"
                    style={{ fontSize: 13, color: C.muted, paddingTop: 24 }}
                  >
                    No matching settings
                  </text>
                )}
            </div>
          )}
          {section === 'appearance' && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <SettingsGroupLabel>Theme</SettingsGroupLabel>
              <SettingsCard>
                {match('Theme', 'color theme') && (
                  <SettingsRow
                    label="Theme"
                    description="The color theme for the app window."
                    last
                    control={
                      <SettingsSelect
                        testId="settings-theme"
                        value={settings.theme}
                        onChange={(next) => onChange({ theme: next as ThemeId })}
                        items={(Object.keys(THEMES) as ThemeId[]).map((id) => ({
                          value: id,
                          label: THEMES[id].label,
                        }))}
                      />
                    }
                  />
                )}
              </SettingsCard>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingBottom: 8,
                  paddingTop: 24,
                }}
              >
                <text style={{ fontSize: 13, fontWeight: 500, color: C.secondary, flexGrow: 1 }}>
                  Typography
                </text>
                <text style={{ fontSize: 13, color: C.tertiary, paddingRight: 8 }}>Advanced</text>
                <Switch
                  testId="settings-advanced"
                  label="Advanced typography options"
                  checked={settings.typographyAdvanced}
                  onChange={(next) => onChange({ typographyAdvanced: next })}
                />
              </div>
              <SettingsCard>
                {match('Interface font', 'outside code blocks') && (
                  <SettingsRow
                    label="Interface font"
                    description="Everything outside code blocks and the terminal."
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <FilterSelect
                          testId="settings-sans"
                          ariaLabel="Interface font"
                          value={settings.sansId}
                          onChange={(next) => onChange({ sansId: next })}
                          items={sansOptions}
                          menuWidth={280}
                        />
                        <SettingsSelect
                          testId="settings-sans-size"
                          value={String(settings.sansSize)}
                          onChange={(next) => onChange({ sansSize: Number(next) })}
                          items={SANS_SIZES.map((size) => ({
                            value: String(size),
                            label: `${size} px`,
                          }))}
                          menuWidth={120}
                        />
                      </div>
                    }
                  />
                )}
                {q === '' && (
                  <div style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 16, paddingTop: 12 }}>
                    <div
                      style={{
                        backgroundColor: C.composer,
                        borderWidth: 1,
                        borderColor: C.border,
                        borderRadius: 10,
                        paddingTop: 10,
                        paddingBottom: 10,
                        paddingLeft: 12,
                        paddingRight: 12,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <text
                          style={{
                            fontSize: settings.sansSize,
                            lineHeight: Math.round(settings.sansSize * 1.5),
                            fontFamily: sansFamily,
                            color: C.text,
                          }}
                        >
                          Use
                        </text>
                        {[
                          { label: 'Frontend Design', bg: C.accentWash, border: C.accent + '40' },
                          { label: 'surface.test.ts', bg: C.successWash, border: C.success + '30' },
                          { label: 'SettingsPanels.tsx', bg: C.warningWash, border: C.warning + '30' },
                        ].map((chip) => (
                          <div
                            key={chip.label}
                            style={{
                              backgroundColor: chip.bg,
                              borderWidth: 1,
                              borderColor: chip.border,
                              borderRadius: 6,
                              paddingLeft: 6,
                              paddingRight: 6,
                              paddingTop: 2,
                              paddingBottom: 2,
                            }}
                          >
                            <text
                              style={{
                                fontSize: settings.monoSize,
                                fontFamily: monoFamily,
                                color: C.text,
                              }}
                            >
                              {chip.label}
                            </text>
                          </div>
                        ))}
                        <text
                          style={{
                            fontSize: settings.sansSize,
                            lineHeight: Math.round(settings.sansSize * 1.5),
                            fontFamily: sansFamily,
                            color: C.text,
                          }}
                        >
                          before shipping.
                        </text>
                      </div>
                    </div>
                  </div>
                )}
                {match('Monospace font', 'code blocks') && (
                  <SettingsRow
                    label="Monospace font"
                    description="Code blocks, diffs, file previews, and the terminal."
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <FilterSelect
                          testId="settings-mono"
                          ariaLabel="Monospace font"
                          value={settings.monoId}
                          onChange={(next) => onChange({ monoId: next })}
                          items={monoOptions}
                          menuWidth={280}
                        />
                        <SettingsSelect
                          testId="settings-mono-size"
                          value={String(settings.monoSize)}
                          onChange={(next) => onChange({ monoSize: Number(next) })}
                          items={MONO_SIZES.map((size) => ({
                            value: String(size),
                            label: `${size} px`,
                          }))}
                          menuWidth={120}
                        />
                      </div>
                    }
                  />
                )}
                
                {q === '' && (
                  <div
                    style={{
                      paddingLeft: 16,
                      paddingRight: 16,
                      paddingBottom: 16,
                      paddingTop: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        backgroundColor: C.composer,
                        borderWidth: 1,
                        borderColor: C.border,
                        borderRadius: 10,
                        overflow: 'hidden',
                      }}
                    >
                      <diff patch={SAMPLE_DIFF_PATCH} wordDiff theme={currentTheme()} />
                    </div>
                    <div
                      style={{
                        backgroundColor: C.composer,
                        borderWidth: 1,
                        borderColor: C.border,
                        borderRadius: 10,
                        paddingTop: 10,
                        paddingBottom: 10,
                        paddingLeft: 12,
                        paddingRight: 12,
                        overflow: 'hidden',
                      }}
                    >
                      <code code={SAMPLE_TERMINAL} theme={currentTheme()} style={CODE_BODY_STYLE} />
                    </div>
                  </div>
                )}
                {settings.typographyAdvanced &&
                  match('Line height', 'compact comfortable') && (
                    <SettingsRow
                      label="Line height"
                      description="Compact packs more lines on screen; comfortable opens body copy up."
                      control={
                        <SettingsSelect
                          testId="settings-line-height"
                          value={settings.lineHeight}
                          onChange={(next) =>
                            onChange({ lineHeight: next as SettingsState['lineHeight'] })
                          }
                          items={[
                            { value: 'comfortable', label: 'Comfortable' },
                            { value: 'compact', label: 'Compact' },
                          ]}
                          menuWidth={160}
                        />
                      }
                    />
                  )}
                {match('Word wrap', 'table') && (
                  <SettingsRow
                    label="Word wrap"
                    description="Wrap long lines in table cells instead of scrolling them sideways. Code blocks and diffs always scroll."
                    last
                    control={
                      <Switch
                        testId="settings-word-wrap"
                        label="Word wrap"
                        checked={settings.wordWrap}
                        onChange={(next) => onChange({ wordWrap: next })}
                      />
                    }
                  />
                )}
              </SettingsCard>
              {q !== '' &&
                !match('Theme', 'color theme') &&
                !match('Interface font', 'outside code blocks') &&
                !match('Monospace font', 'code blocks') &&
                !match('Line height', 'compact comfortable') &&
                !match('Word wrap', 'table') && (
                  <text
                    testId="settings-empty"
                    style={{ fontSize: 13, color: C.muted, paddingTop: 24 }}
                  >
                    No matching settings
                  </text>
                )}
            </div>
          )}
          {section === 'providers' && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <SettingsGroupLabel>Default</SettingsGroupLabel>
              <SettingsCard>
                {match('Default provider', 'new threads') && (
                  <SettingsRow
                    label="Default provider"
                    description="The provider new threads start on."
                    last={providerError === ''}
                    control={
                      <SettingsSelect
                        testId="settings-default-provider"
                        value={defaultProvider}
                        onChange={onDefaultProvider}
                        items={providers.map((provider) => ({
                          value: provider.id,
                          label: provider.name,
                        }))}
                        menuWidth={260}
                      />
                    }
                  />
                )}
                {providerError !== '' && (
                  <SettingsRow
                    label="Last error"
                    description={providerError}
                    last
                    control={
                      <SettingsButton
                        testId="settings-providers-refresh"
                        label="Refresh"
                        onClick={onRefreshProviders}
                      />
                    }
                  />
                )}
              </SettingsCard>
              <SettingsGroupLabel>Connections</SettingsGroupLabel>
              <SettingsCard>
                {match('Codex', 'ChatGPT subscription') && (
                  <SettingsRow
                    label="Codex"
                    description="Uses your ChatGPT subscription. Run `escape login codex` in a terminal, then Refresh."
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <ProviderStatus connected={providerStatus('codex')} />
                        <SettingsButton
                          testId="settings-providers-refresh-codex"
                          label="Refresh"
                          onClick={onRefreshProviders}
                        />
                      </div>
                    }
                  />
                )}
                {match('OpenCode Go', 'API key') && (
                  <SettingsRow
                    label="OpenCode Go"
                    description="Use an OpenCode Go API key for managed models. Stored in ~/.escape/credentials.json."
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <ProviderStatus connected={providerStatus('opencode-go')} />
                        {!providerStatus('opencode-go') && (
                          <SettingsTextInput
                            testId="settings-go-key"
                            value={goKey}
                            onChange={setGoKey}
                            placeholder="API key"
                            width={160}
                          />
                        )}
                        {providerStatus('opencode-go') ? (
                          <SettingsButton
                            testId="settings-go-disconnect"
                            label="Disconnect"
                            danger
                            onClick={() => onRemoveKey('opencode-go')}
                          />
                        ) : (
                          <SettingsButton
                            testId="settings-go-connect"
                            label="Connect"
                            onClick={() => {
                              if (goKey.trim() === '') return
                              onSaveKey('opencode-go', goKey.trim())
                              setGoKey('')
                            }}
                          />
                        )}
                      </div>
                    }
                  />
                )}
                {match('OpenCode Zen', 'API key') && (
                  <SettingsRow
                    label="OpenCode Zen"
                    description="Use an OpenCode Zen API key for managed models. Stored in ~/.escape/credentials.json."
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 12,
                        }}
                      >
                        <ProviderStatus connected={providerStatus('opencode-zen')} />
                        {!providerStatus('opencode-zen') && (
                          <SettingsTextInput
                            testId="settings-zen-key"
                            value={zenKey}
                            onChange={setZenKey}
                            placeholder="API key"
                            width={160}
                          />
                        )}
                        {providerStatus('opencode-zen') ? (
                          <SettingsButton
                            testId="settings-zen-disconnect"
                            label="Disconnect"
                            danger
                            onClick={() => onRemoveKey('opencode-zen')}
                          />
                        ) : (
                          <SettingsButton
                            testId="settings-zen-connect"
                            label="Connect"
                            onClick={() => {
                              if (zenKey.trim() === '') return
                              onSaveKey('opencode-zen', zenKey.trim())
                              setZenKey('')
                            }}
                          />
                        )}
                      </div>
                    }
                  />
                )}
                {match('OpenAI-compatible API', 'custom endpoint') && (
                  <SettingsRow
                    label="OpenAI-compatible API"
                    description="A custom endpoint. The URL defaults to api.openai.com; a blank key keeps the stored one."
                    last
                    control={
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <ProviderStatus connected={providerStatus('api')} />
                        {!providerStatus('api') && (
                          <>
                            <SettingsTextInput
                              testId="settings-endpoint-url"
                              value={epUrl}
                              onChange={setEpUrl}
                              placeholder={apiBaseURL || 'https://…'}
                              width={170}
                            />
                            <SettingsTextInput
                              testId="settings-endpoint-key"
                              value={epKey}
                              onChange={setEpKey}
                              placeholder="API key"
                              width={130}
                            />
                          </>
                        )}
                        {providerStatus('api') ? (
                          <SettingsButton
                            testId="settings-endpoint-disconnect"
                            label="Disconnect"
                            danger
                            onClick={() => onRemoveKey('api')}
                          />
                        ) : (
                          <SettingsButton
                            testId="settings-endpoint-save"
                            label="Save"
                            onClick={() => {
                              if (epUrl.trim() === '' && epKey.trim() === '') return
                              onSaveEndpoint(epUrl.trim(), epKey.trim())
                              setEpUrl('')
                              setEpKey('')
                            }}
                          />
                        )}
                      </div>
                    }
                  />
                )}
              </SettingsCard>
              {q !== '' &&
                !match('Default provider', 'new threads') &&
                !match('Codex', 'ChatGPT subscription') &&
                !match('OpenCode Go', 'API key') &&
                !match('OpenCode Zen', 'API key') &&
                !match('OpenAI-compatible API', 'custom endpoint') && (
                  <text
                    testId="settings-empty"
                    style={{ fontSize: 13, color: C.muted, paddingTop: 24 }}
                  >
                    No matching settings
                  </text>
                )}
            </div>
          )}
          {section === 'source' && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <SettingsGroupLabel>Repository</SettingsGroupLabel>
              <SettingsCard>
                <SettingsRow
                  label="Branch"
                  description={gitBranch ? `On ${gitBranch}` : 'Not a git repository'}
                  control={
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          paddingLeft: 8,
                          paddingRight: 8,
                          height: 28,
                          borderRadius: 7,
                          backgroundColor: gitDirty ? C.warningWash : C.overlay,
                          borderWidth: gitDirty ? 1 : 0,
                          borderColor: gitDirty ? C.warning + '30' : undefined,
                        }}
                      >
                        <Icon name="gitBranch" size={12} color={gitDirty ? C.warning : C.tertiary} />
                        <text style={{ fontSize: 12.5, color: C.text }}>{gitBranch || '—'}</text>
                        {gitDirty ? (
                          <text style={{ fontSize: 11, fontWeight: 600, color: C.warning }}>{`● ${gitDirty}`}</text>
                        ) : null}
                      </div>
                      <SettingsButton testId="settings-git-refresh" label="Refresh" onClick={onRefreshGit} />
                    </div>
                  }
                />
                <SettingsRow
                  label="Uncommitted changes"
                  description={gitDirty ? `${gitDirty} files modified` : 'Working tree clean'}
                  last
                  control={
                    <SettingsButton
                      testId="settings-git-diff"
                      label={gitDirty ? `View diff (${gitDirty})` : 'View diff'}
                      onClick={onOpenDiff}
                    />
                  }
                />
              </SettingsCard>
              <SettingsGroupLabel>Workspace</SettingsGroupLabel>
              <SettingsCard>
                <SettingsRow
                  label="Where new threads start"
                  description="Projects and their t3.json can override it."
                  control={
                    <SettingsSelect
                      testId="settings-workspace"
                      value={settings.workspaceMode}
                      onChange={(next) => onChange({ workspaceMode: next as SettingsState['workspaceMode'] })}
                      items={[
                        { value: 'current', label: 'Current checkout' },
                        { value: 'worktree', label: 'New worktree' },
                      ]}
                      menuWidth={180}
                    />
                  }
                />
                <SettingsRow
                  label="How worktrees populate submodules"
                  description="Matches t3code's General → Submodules."
                  last
                  control={
                    <SettingsSelect
                      testId="settings-submodules"
                      value={settings.submoduleMode}
                      onChange={(next) => onChange({ submoduleMode: next as SettingsState['submoduleMode'] })}
                      items={[
                        { value: 'recursive', label: 'Recursive' },
                        { value: 'shallow', label: 'Shallow' },
                      ]}
                      menuWidth={160}
                    />
                  }
                />
              </SettingsCard>
              <SettingsGroupLabel>Automation</SettingsGroupLabel>
              <SettingsCard>
                <SettingsRow
                  label="Auto-refresh git status"
                  description="Poll the working tree every 15s while this project is open."
                  last
                  control={
                    <Switch
                      testId="settings-git-autofetch"
                      label="Auto-refresh git status"
                      checked={settings.gitAutoFetch}
                      onChange={(next) => onChange({ gitAutoFetch: next })}
                    />
                  }
                />
              </SettingsCard>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AgentStatusRow({ status }: { status: AgentStatus }) {
  const label = agentStatusLabel(status)
  if (label === '') return null
  return (
    <div
      testId="agent-status"
      role="status"
      aria-live="polite"
      style={{
        display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingTop: 2, paddingBottom: 2, width: '100%', minWidth: 0,
      }}
    >
      {/* A static dot rather than a spinner: GPUIX has no animation primitive,
          and a dot that does not move is honest about a stream that is
          arriving in blocks. */}
      <div
        style={{
          width: 6, height: 6, borderRadius: 3, flexShrink: 0,
          backgroundColor: C.accent,
        }}
      />
      <text style={{ fontSize: 12.5, color: C.tertiary }}>{label}</text>
    </div>
  )
}

const Transcript = memo(function Transcript({
  rows,
  listRef,
  onOpenDiff,
  onCopy,
  status,
  turns,
  designPhases,
  designOutcome,
}: {
  rows: TimelineRow[]
  listRef?: React.Ref<PublicInstance>
  onOpenDiff?: () => void
  onCopy: (text: string) => Promise<void>
  status: AgentStatus
  turns: TurnLedger
  designPhases: DesignPhase[]
  designOutcome: DesignOutcome | null
}) {
  const visible = rows.filter(
    (row) => row.kind !== 'message' || row.message.role === 'user' || row.message.content !== '',
  )
  const statusLabel = agentStatusLabel(status)
  return (
    <virtual-list
      ref={listRef}
      // GPUIX's own tail-following: it pins to the newest row as content grows
      // and releases when the user scrolls away, which is the behaviour the
      // streaming transcript needs. Hand-rolling it with scrollToItem could not
      // detect a user scrolling up.
      followTail
      overdraw={80}
      estimatedItemHeight={220}
      style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
    >
      {visible.map((row, index) => (
        <TranscriptRow key={row.key} first={index === 0} last={index === visible.length - 1}>
          {row.kind === 'message' && row.message.role === 'user' && (
            <UserTurn text={row.message.content} />
          )}
          {row.kind === 'message' && row.message.role === 'assistant' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', minWidth: 0 }}>
              <SafeMdxContent source={row.message.content} onCopy={onCopy} />
              {index === visible.length - 1 && (
                <ActionBar text={row.message.content} onCopy={onCopy} />
              )}
            </div>
          )}
          {row.kind === 'activity' && (
            <WorkedFor
              duration={turnDurationLabel(turns[row.turnId], row.activities)}
              tools={row.activities}
            />
          )}
          {row.kind === 'diff' && <TurnDiff patch={row.patch} onOpenDiff={onOpenDiff} />}
        </TranscriptRow>
      ))}
      {/* The status row is a sibling of the rows rather than inside the last
          one, so it appears even when the transcript's last row is a tool fold
          or a diff card. Announced politely so it does not interrupt a screen
          reader mid-sentence. */}
      {(designPhases.length > 0 || designOutcome !== null) && (
        <TranscriptRow first={false} last={statusLabel === ''}>
          <DesignRun reported={designPhases} outcome={designOutcome} />
        </TranscriptRow>
      )}
      {statusLabel !== '' && (
        <TranscriptRow first={false} last>
          <AgentStatusRow status={status} />
        </TranscriptRow>
      )}
    </virtual-list>
  )
})

function Header({
  collapsed,
  onExpand,
  title,
  gitBranch,
  gitDirty,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onToggleDiff,
  onToggleGit,
}: {
  collapsed: boolean
  onExpand: () => void
  title: string
  gitBranch: string
  gitDirty: number
  canGoBack: boolean
  canGoForward: boolean
  onBack: () => void
  onForward: () => void
  onToggleDiff: () => void
  onToggleGit: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: TITLEBAR_HEIGHT,
        flexShrink: 0,
        paddingLeft: collapsed ? 0 : 14,
        paddingRight: 14,
        userSelect: 'none',
      }}
    >
      {collapsed && (
        <>
          <div style={{ width: TRAFFIC_LIGHT_CLEARANCE - 8, height: '100%', flexShrink: 0 }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <IconButton icon="sidebar" testId="sidebar-expand" onClick={onExpand} />
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <IconButton icon="arrowLeft" dimmed={!canGoBack} onClick={onBack} />
              <IconButton icon="arrowRight" dimmed={!canGoForward} onClick={onForward} />
            </div>
          </div>
        </>
      )}
      <text
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: C.text,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          minWidth: 0,
          flexShrink: 1,
        }}
      >
        {title}
      </text>
      <div style={{ flexGrow: 1 }} />
      {gitBranch ? (
        <div
          testId="header-git"
          role="button"
          aria-label={`Git branch ${gitBranch}${gitDirty ? `, ${gitDirty} changes` : ''}`}
          tabIndex={0}
          onClick={onToggleGit}
          onKeyDown={(e: { key?: string }) => {
            if (e.key === 'enter' || e.key === ' ') onToggleGit()
          }}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 24,
            paddingLeft: 8,
            paddingRight: 8,
            borderRadius: 7,
            borderWidth: gitDirty ? 1 : 0,
            borderColor: gitDirty ? C.warning + '40' : undefined,
            backgroundColor: gitDirty ? C.warningWash : C.overlay,
            cursor: 'pointer',
            hover: { backgroundColor: gitDirty ? C.warningWash : C.overlayStrong },
          }}
        >
          <Icon name="gitBranch" size={12} color={gitDirty ? C.warning : C.tertiary} />
          <text style={{ fontSize: 12, fontWeight: 500, color: gitDirty ? C.text : C.secondary }}>{gitBranch}</text>
          {gitDirty ? (
            <div
              style={{
                backgroundColor: C.warning,
                borderRadius: 6,
                paddingLeft: 5,
                paddingRight: 5,
                height: 16,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <text style={{ fontSize: 11, fontWeight: 600, color: C.onInverse }}>{`● ${gitDirty}`}</text>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* The branch chip opens Source Control too, but it only renders on a
          real branch, and a turn's "Open diff" only exists once the agent has
          edited something. Neither is reachable on a clean tree, a detached
          HEAD, or a fresh project — so the panel needs an entry point that is
          always there. */}
      <IconButton icon="gitBranch" testId="source-control-toggle" onClick={onToggleGit} />
      <IconButton icon="file" testId="diff-toggle" onClick={onToggleDiff} />
    </div>
  )
}

const MENU = {
  minWidth: 220,
  paddingTop: 4,
  paddingBottom: 4,
  paddingLeft: 4,
  paddingRight: 4,
  backgroundColor: C.raised,
  borderWidth: 1,
  borderColor: C.borderStrong,
  borderRadius: 12,
} satisfies StyleDesc

function menuItemStyle(state: { selected: boolean; highlighted: boolean }): StyleDesc {
  return {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    borderRadius: 7,
    backgroundColor: state.highlighted ? '#404040' : state.selected ? '#2C2C2C' : C.raised,
    hover: { backgroundColor: '#404040' },
    cursor: 'pointer',
  }
}

type MenuRowProps = Props & {
  label: string
  description?: string
  icon?: IconName
  selected: boolean
  hint?: string
}

const MenuRow = React.forwardRef<PublicInstance, MenuRowProps>(function MenuRow(
  { label, description, icon, selected, hint, style, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        paddingTop: description ? 6 : 5,
        paddingBottom: description ? 6 : 5,
        paddingLeft: 8,
        paddingRight: 8,
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={14} color={C.tertiary} />}
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <text
          style={{
            fontSize: 12.5,
            fontWeight: selected ? 600 : 500,
            color: C.text,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </text>
        {description && (
          <text style={{ fontSize: 12.5, lineHeight: 14, color: C.tertiary, paddingTop: 2 }}>
            {description}
          </text>
        )}
      </div>
      {hint && <text style={{ fontSize: 11.5, color: C.muted, flexShrink: 0 }}>{hint}</text>}
      {selected && <Icon name="check" size={11} color={C.tertiary} />}
    </div>
  )
})

function ChipSelect({
  value,
  onChange,
  items,
  icon,
  label,
  caret = true,
  accent,
  menuWidth,
  testId,
  children,
}: {
  value: string
  onChange: (next: string) => void
  items: { value: string; label: string }[]
  icon: IconName
  label: string
  caret?: boolean
  accent?: boolean
  menuWidth?: number
  testId?: string
  children: React.ReactNode
}) {
  return (
    <Select items={items} value={value} onValueChange={onChange} style={{ flexShrink: 0 }}>
      <div style={{ position: 'relative', display: 'flex' }}>
        <SelectTrigger
          testId={testId}
          style={(state) => ({
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 26,
            paddingLeft: 7,
            paddingRight: 7,
            borderRadius: 6,
            cursor: 'pointer',
            backgroundColor: state.open ? C.overlay : '#00000000',
            hover: { backgroundColor: C.overlay },
          })}
        >
          <Icon name={icon} size={12} color={accent ? C.accent : C.tertiary} />
          <text
            style={{
              fontSize: 13,
              lineHeight: 16,
              color: accent ? C.accent : C.secondary,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {label}
          </text>
          {caret && <Icon name="chevronDown" size={10.5} color={C.ghost} />}
        </SelectTrigger>
        <SelectContent side="top" sideOffset={4} style={{ ...MENU, minWidth: menuWidth ?? 220 }}>
          {children}
        </SelectContent>
      </div>
    </Select>
  )
}


function thinkingLabel(level: string): string {
  return level ? level[0]!.toUpperCase() + level.slice(1) : level
}

/**
 * Splits a label into the runs a fuzzy matcher used, so the UI can colour them.
 *
 * The indices come from the engine's own matcher, so what is highlighted is
 * what produced the ranking. A client-side re-match could pick different
 * characters and would then be explaining an order it did not decide.
 */
export function highlightRuns(
  label: string,
  match: readonly number[] | undefined,
): { text: string; matched: boolean }[] {
  if (!match || match.length === 0) return [{ text: label, matched: false }]
  const hit = new Set(match.filter((i) => i >= 0 && i < label.length))
  const runs: { text: string; matched: boolean }[] = []
  let start = 0
  for (let i = 1; i <= label.length; i++) {
    const atEnd = i === label.length
    if (!atEnd && hit.has(i) === hit.has(start)) continue
    runs.push({ text: label.slice(start, i), matched: hit.has(start) })
    start = i
  }
  return runs
}

/**
 * The window key handler, while a dialog needs keys an input cannot take.
 *
 * GPUIX delivers key events to the window and to whatever holds focus, not to
 * the element's own onKeyDown, so an input handler for arrow keys never fires.
 * The only window handler belongs to the root render, which lives outside React
 * and cannot read state, so a dialog parks a handler here and clears it when it
 * closes. The handler returns true when it consumed the key.
 */
let windowKeyHandler: ((key: string) => boolean) | null = null

function setWindowKeyHandler(handler: ((key: string) => boolean) | null): void {
  windowKeyHandler = handler
}

/**
 * The window's key entry point.
 *
 * Exported so a test root registers the same handler the real window does.
 * Anything driven by arrow keys is otherwise untestable, because the test
 * harness builds its own root and never sees the bootstrap's options.
 */
export function dispatchWindowKey(event: { key?: string }): boolean {
  if (!event.key) return false
  return windowKeyHandler?.(event.key) ?? false
}

export function projectName(path: string): string {
  const clean = path.replace(/\/+$/, '')
  const slash = clean.lastIndexOf('/')
  return slash >= 0 ? clean.slice(slash + 1) : clean || path
}

const ACCESS = [
  {
    id: 'ask',
    label: 'Ask before running',
    description: 'Every tool call waits for you',
    icon: 'lock' as const,
  },
  {
    id: 'auto',
    label: 'Auto-approve',
    description: 'Tools run without asking',
    icon: 'lockOpen' as const,
  },
]

function ModelPicker({
  value,
  models,
  onChange,
}: {
  value: string
  models: ModelInfo[]
  onChange: (next: string) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) =>
        (m.name ?? m.id).toLowerCase().includes(q) ||
        (m.provider ?? '').toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q),
    )
  }, [models, query])
  const groups = useMemo(() => {
    const out: { name: string; items: ModelInfo[] }[] = []
    for (const model of filtered) {
      const name = model.provider ?? 'Other'
      const last = out[out.length - 1]
      if (last && last.name === name) last.items.push(model)
      else out.push({ name, items: [model] })
    }
    return out
  }, [filtered])
  const keyFor = (m: ModelInfo) => `${m.provider ?? 'Other'}::${m.id}`
  const idFromKey = (key: string) => key.split('::').slice(1).join('::')
  const selected = models.find((m) => m.id === value) ?? models[0]
  const selectedKey = selected ? keyFor(selected) : undefined
  const label = selected?.name ?? selected?.id ?? 'Model'

  return (
    <ChipSelect
      value={selectedKey ?? value}
      onChange={(next) => {
        setQuery('')
        onChange(idFromKey(next))
      }}
      items={models.map((model) => ({ value: keyFor(model), label: model.name ?? model.id }))}
      icon="sparkle"
      label={label}
      testId="model-picker"
    >
      <input
        testId="model-search"
        aria-label="Search models"
        value={query}
        placeholder="Search models..."
        autoFocus
        theme={{ caret: C.accent, text: C.text, textMuted: C.muted }}
        style={{
          width: '100%',
          height: 28,
          flexShrink: 0,
          fontSize: 13,
          fontFamily: FONT_SANS,
          color: C.text,
          backgroundColor: C.composer,
          borderWidth: 1,
          borderColor: C.border,
          borderRadius: 7,
          paddingLeft: 8,
          paddingRight: 8,
          marginBottom: 6,
        }}
        onChange={(event) => setQuery(event.value ?? '')}
      />
      <div
        testId="model-list"
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 320,
          minHeight: 0,
          overflowY: 'scroll',
        }}
      >
        {groups.length === 0 ? (
          <text style={{ fontSize: 12.5, color: C.muted, paddingLeft: 8, paddingTop: 6 }}>No models match</text>
        ) : (
          groups.map((group, index) => (
            <div key={group.name} style={{ display: 'flex', flexDirection: 'column' }}>
              {index > 0 && (
                <div style={{ height: 1, backgroundColor: C.border, marginTop: 4, marginBottom: 4 }} />
              )}
              <SelectLabel
                style={{
                  height: 22,
                  paddingLeft: 8,
                  paddingRight: 8,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted }}>{group.name}</text>
              </SelectLabel>
              {group.items.map((model) => (
                <SelectItem
                  asChild
                  key={keyFor(model)}
                  value={keyFor(model)}
                  testId={`model-${model.id}`}
                  style={(state) => menuItemStyle(state)}
                >
                  {(state) => (
                    <MenuRow label={model.name ?? model.id} icon="sparkle" selected={state.selected} />
                  )}
                </SelectItem>
              ))}
            </div>
          ))
        )}
      </div>
      <text style={{ fontSize: 11, color: C.muted, paddingLeft: 8, paddingTop: 4 }}>
        {filtered.length !== models.length ? `${filtered.length} of ${models.length}` : `${models.length} models`}
      </text>
    </ChipSelect>
  )
}

function ReasoningPicker({
  value,
  levels,
  onChange,
}: {
  value: string
  levels: string[]
  onChange: (next: string) => void
}) {
  const label = levels.includes(value) ? thinkingLabel(value) : 'Reasoning'
  return (
    <ChipSelect
      value={value}
      onChange={onChange}
      items={levels.map((level) => ({ value: level, label: thinkingLabel(level) }))}
      icon={value === 'off' || value === 'low' || value === 'minimal' ? 'zap' : 'sparkle'}
      label={label}
      caret={false}
      testId="reasoning-picker"
    >
      <SelectLabel
        style={{
          height: 22,
          paddingLeft: 8,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <text style={{ fontSize: 11.5, fontWeight: 500, color: C.muted }}>Reasoning</text>
      </SelectLabel>
      {levels.map((level) => (
        <SelectItem
          asChild
          key={level}
          value={level}
          testId={`reasoning-${level}`}
          style={(state) => menuItemStyle(state)}
        >
          {(state) => (
            <MenuRow label={thinkingLabel(level)} selected={state.selected} />
          )}
        </SelectItem>
      ))}
    </ChipSelect>
  )
}

/**
 * The composer's Design Mode toggle.
 *
 * This is the shell's own front door, not a shortcut that types /design and
 * hopes the engine's command does the right thing. A design run is minutes long
 * and reports phases as it goes, so the shell has to own the request, the busy
 * state, the phase list and the verdict. Forwarding to the engine's command
 * would hand all four back as text to re-parse.
 */
function DesignToggle({
  on,
  busy,
  onToggle,
}: {
  on: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <div
      testId="design-toggle"
      role="switch"
      aria-checked={on}
      aria-label="Design Mode"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(event: { key?: string }) => {
        if (event.key === 'enter' || event.key === ' ') onToggle()
      }}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        height: 24,
        paddingLeft: 8,
        paddingRight: 9,
        borderRadius: 6,
        cursor: busy ? 'default' : 'pointer',
        backgroundColor: on ? C.overlay : 'transparent',
        opacity: busy && !on ? 0.5 : 1,
      }}
    >
      <Icon name="sparkle" size={12} color={on ? C.accent : C.tertiary} />
      <text style={{ fontSize: 12.5, fontWeight: on ? 600 : 400, color: on ? C.accent : C.secondary }}>
        {busy && on ? 'Designing…' : 'Design'}
      </text>
    </div>
  )
}

function AccessPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const selected = ACCESS.find((option) => option.id === value) ?? ACCESS[0]
  return (
    <ChipSelect
      value={selected.id}
      onChange={onChange}
      items={ACCESS.map((option) => ({ value: option.id, label: option.label }))}
      icon={selected.icon}
      label={selected.label}
      caret={false}
      menuWidth={288}
      testId="access-trigger"
    >
      {ACCESS.map((option) => (
        <SelectItem
          asChild
          key={option.id}
          value={option.id}
          testId={`access-${option.id}`}
          style={(state) => menuItemStyle(state)}
        >
          {(state) => (
            <MenuRow
              label={option.label}
              description={option.description}
              icon={option.icon}
              selected={state.selected}
            />
          )}
        </SelectItem>
      ))}
    </ChipSelect>
  )
}

/**
 * Splits a token stream into whole blocks before it is painted.
 *
 * The engine sends one delta per token, and painting each one re-renders the
 * transcript and re-parses the markdown. That makes an answer type itself out
 * character by character, which is both hard to read and expensive to render.
 *
 * Text is held until a block boundary is seen — a blank line ends a paragraph,
 * a newline after a Markdown heading ends the heading — so what appears is a
 * finished paragraph or heading rather than a growing word. A time budget
 * releases a long paragraph that has not reached its boundary yet, so output
 * never stalls, and `flush` on settle guarantees the tail is never dropped.
 *
 * Pure logic, so the boundaries are testable without a renderer.
 */
export function createBlockStreamer(
  emit: (chunk: string) => void,
  options: { maxDelayMs?: number; now?: () => number } = {},
) {
  const maxDelayMs = options.maxDelayMs ?? 120
  const now = options.now ?? (() => Date.now())
  let buffer = ''
  let firstAt: number | null = null

  const release = () => {
    if (!buffer) return
    const chunk = buffer
    buffer = ''
    firstAt = null
    emit(chunk)
  }

  // The last index a safe cut can happen at: after a blank line, or after the
  // newline that terminates a heading.
  const safeCut = (text: string): number => {
    let cut = -1
    // Paragraph end: two newlines, tolerating trailing spaces on the blank line.
    const para = /\n[ \t]*\n/g
    for (let m = para.exec(text); m; m = para.exec(text)) {
      cut = m.index + m[0].length
    }
    // Heading end: "# text" (or "##", …) followed by a newline.
    const heading = /(^|\n)#{1,6}[ \t][^\n]*\n/g
    for (let m = heading.exec(text); m; m = heading.exec(text)) {
      const end = m.index + m[0].length
      if (end > cut) cut = end
    }
    return cut
  }

  // A cut is only safe if it does not land inside a tag, a fenced code block,
  // or a multi-line construct. Cutting inside `<span style="col` would hand
  // the markdown parser half a tag, which is a hard parse error, not a warning.
  const isSafeToCut = (text: string, at: number): boolean => {
    if (at >= text.length) return true
    const before = text.slice(0, at)
    // Inside an unterminated fenced code block.
    const fences = (before.match(/^```/gm) ?? []).length
    if (fences % 2 === 1) return false
    // An odd number of unclosed '<' since the last '>' means the cut lands
    // inside a tag. Cheap and sufficient: real tags are short.
    const lastOpen = before.lastIndexOf('<')
    const lastClose = before.lastIndexOf('>')
    if (lastOpen > lastClose) return false
    return true
  }

  return {
    push(text: string) {
      if (!text) return
      if (firstAt === null) firstAt = now()
      buffer += text
      const cut = safeCut(buffer)
      if (cut > 0 && isSafeToCut(buffer, cut)) {
        emit(buffer.slice(0, cut))
        buffer = buffer.slice(cut)
        firstAt = buffer ? now() : null
        return
      }
      // A long paragraph with no boundary: release what we have rather than
      // holding it indefinitely, so a slow answer still shows progress.
      // The cut is walked back to the last safe point for the same reason.
      if (now() - firstAt >= maxDelayMs) {
        let end = buffer.length
        while (end > 0 && !isSafeToCut(buffer, end)) end--
        if (end > 0) {
          emit(buffer.slice(0, end))
          buffer = buffer.slice(end)
          firstAt = now()
        }
      }
    },
    /** Releases everything held. Called when the turn settles. */
    flush() {
      release()
    },
    /** Text held but not yet released, for tests. */
    pending() {
      return buffer
    },
  }
}

/**
 * What the agent is doing right now, for the live status row.
 *
 * Derived from the events the engine already emits rather than a new protocol:
 * a turn that has started but produced nothing is thinking, text means it is
 * writing, a tool in flight names the tool, and compaction says so explicitly.
 * Only the tool call is named in the text — the rest is a state, and printing a
 * bare state ("thinking") next to a live answer reads as noise.
 */
export type AgentStatus =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'writing' }
  | { kind: 'tool'; tool: string }
  | { kind: 'compacting' }

/**
 * Folds agent events into the current status.
 *
 * Pure and total, so every transition is testable without a renderer. The tool
 * set is carried across events because a turn can have several in flight and
 * the newest one is the one worth naming; a completed tool is removed, and the
 * status falls back to whatever the turn was doing before it started.
 */
export function reduceAgentStatus(
  current: AgentStatus,
  running: Set<string>,
  event: AgentEvent,
): { status: AgentStatus; running: Set<string> } {
  switch (event.kind) {
    case 'started':
      return { status: { kind: 'thinking' }, running: new Set() }
    case 'text_delta':
      // Text supersedes a tool that finished; a tool still in flight outranks it.
      if (running.size > 0) return { status: current, running }
      return { status: { kind: 'writing' }, running }
    case 'tool_start': {
      const next = new Set(running)
      next.add(event.toolName)
      return { status: { kind: 'tool', tool: event.toolName }, running: next }
    }
    case 'tool_end': {
      const next = new Set(running)
      next.delete(event.toolName)
      if (next.size > 0) {
        // Something is still running; name one of them.
        const tool = next.values().next().value as string
        return { status: { kind: 'tool', tool }, running: next }
      }
      return { status: { kind: 'writing' }, running: next }
    }
    case 'compaction_start':
      return { status: { kind: 'compacting' }, running }
    case 'compaction_end':
    case 'turn_end':
    case 'agent_end':
    case 'settled':
      return { status: { kind: 'idle' }, running: new Set() }
    case 'error':
      return { status: { kind: 'idle' }, running: new Set() }
    default:
      return { status: current, running }
  }
}

export function agentStatusLabel(status: AgentStatus): string {
  switch (status.kind) {
    case 'thinking':
      return 'Thinking…'
    case 'writing':
      return 'Writing…'
    case 'compacting':
      return 'Compacting context…'
    case 'tool':
      // Tool names are snake_case from the engine; a space reads better.
      return `${status.tool.replace(/_/g, ' ')}…`
    default:
      return ''
  }
}

/** What a submit attempt did. A refusal is a value, not a silent return. */
export interface SubmitResult {
  didDispatch: boolean
  validationMessage: string | null
}

/**
 * Why a prompt cannot be sent, or null when it can.
 *
 * Split out from the send path so the reason a keystroke did nothing is a
 * computed fact the UI can show, rather than a branch that quietly returns.
 * `busy` is called out in words because "nothing happened" is the worst possible
 * answer to pressing Enter.
 */
export function validatePrompt(
  prompt: string,
  context: { busy: boolean; engineUp: boolean },
): string | null {
  if (!context.engineUp) return 'The engine is not running.'
  if (context.busy) return 'Wait for the current turn to finish, or stop it first.'
  if (prompt.trim() === '') return null
  return null
}

export type PendingInteraction =
  | { kind: 'approval'; toolCallId: string; toolName: string }
  | { kind: 'question'; questionId: string; question: string }

/** The engine's own account of a turn, keyed by the id it assigned. */
export type TurnStatus = 'running' | 'completed' | 'interrupted' | 'error'

export interface TurnRecord {
  state: TurnStatus
  startedAt: number
  endedAt?: number
}

export type TurnLedger = Readonly<Record<string, TurnRecord>>

/**
 * Folds turn lifecycle events into a ledger of turns.
 *
 * The engine owns turn boundaries, so the UI's job is to record them rather
 * than infer them from message grouping. Two things fall out of that: a turn's
 * duration is the server's own start-to-end span instead of a sum of tool
 * timings, and an interrupted turn stays distinguishable from a failed one.
 *
 * `changed: false` is the point of the second return value. Most events on the
 * wire say nothing about turns, and a caller that wrote state on every event
 * would re-render the whole timeline for each one. Events for a turn already in
 * the state it names are likewise a no-op, so a duplicated `turn_end` cannot
 * rewrite the recorded end time.
 */
export function applyTurnEvent(
  ledger: TurnLedger,
  event: AgentEvent,
  now: number,
): { ledger: TurnLedger; changed: boolean } {
  if (event.kind === 'turn_start' && event.turnId) {
    if (ledger[event.turnId]?.state === 'running') return { ledger, changed: false }
    return {
      ledger: { ...ledger, [event.turnId]: { state: 'running', startedAt: now } },
      changed: true,
    }
  }
  if (event.kind === 'turn_end') {
    // An engine that names no turn still ends the newest one it opened, which
    // is the only turn that can be running.
    const turnId = event.turnId ?? newestRunningTurn(ledger)
    if (!turnId) return { ledger, changed: false }
    const record = ledger[turnId]
    if (record && record.state !== 'running') return { ledger, changed: false }
    const start = record?.startedAt ?? now
    return {
      ledger: {
        ...ledger,
        [turnId]: { state: event.state, startedAt: start, endedAt: now },
      },
      changed: true,
    }
  }
  return { ledger, changed: false }
}

function newestRunningTurn(ledger: TurnLedger): string | undefined {
  let newest: { id: string; startedAt: number } | undefined
  for (const [id, record] of Object.entries(ledger)) {
    if (record.state !== 'running') continue
    if (!newest || record.startedAt >= newest.startedAt) newest = { id, startedAt: record.startedAt }
  }
  return newest?.id
}

function PendingCard({
  pending,
  answer,
  onApprove,
  onAnswer,
  onDismiss,
}: {
  pending: PendingInteraction
  answer: string
  onApprove: (approved: boolean) => void
  onAnswer: (text: string) => void
  onDismiss: (text: string) => void
}) {
  return (
    <div
      testId="pending-card"
      role="dialog"
      aria-label={pending.kind === 'approval' ? 'Approve tool call' : 'Answer question'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flexShrink: 0,
        paddingLeft: 20,
        paddingRight: 20,
        paddingBottom: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          width: '100%',
          maxWidth: CONTENT_MAX_WIDTH,
          backgroundColor: C.raised,
          borderWidth: 1,
          borderColor: C.borderStrong,
          borderRadius: 12,
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 12,
          paddingRight: 12,
        }}
      >
        {pending.kind === 'approval' ? (
          <>
            <text style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
              {`Allow ${pending.toolName}?`}
            </text>
            <text style={{ fontSize: 13, lineHeight: 18, color: C.secondary }}>
              The agent is waiting for approval before running this tool.
            </text>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
              <SettingsButton
                testId="approval-allow"
                label="Allow"
                onClick={() => onApprove(true)}
              />
              <SettingsButton
                testId="approval-deny"
                label="Deny"
                danger
                onClick={() => onApprove(false)}
              />
            </div>
          </>
        ) : (
          <>
            <text style={{ fontSize: 14, fontWeight: 600, color: C.text }}>Agent question</text>
            <text style={{ fontSize: 13, lineHeight: 18, color: C.secondary }}>
              {pending.question}
            </text>
            <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
              <SettingsTextInput
                testId="question-answer"
                value={answer}
                onChange={onDismiss}
                placeholder="Answer…"
              />
              <SettingsButton
                testId="question-send"
                label="Send"
                onClick={() => onAnswer(answer)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function WorkspaceFooter({ connected }: { connected: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flexShrink: 0,
        paddingLeft: 20,
        paddingRight: 20,
        paddingTop: 4,
        paddingBottom: 8,
        userSelect: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          width: '100%',
          maxWidth: CONTENT_MAX_WIDTH,
          height: 28,
          paddingLeft: 10,
          paddingRight: 10,
        }}
      >
        {/* The project switcher used to live here, next to the engine light. It
            is in the sidebar now, where the projects are listed, and leaving a
            second control for the same choice would show the current project in
            two places and offer two ways to change it. */}
        <div style={{ flexGrow: 1 }} />
        <div
          testId="engine-status"
          aria-label={connected ? 'Engine connected' : 'Engine unreachable'}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: connected ? C.success : C.ghost,
            flexShrink: 0,
          }}
        />
      </div>
    </div>
  )
}

function Composer({
  value,
  onChange,
  onSend,
  model,
  models,
  onModelChange,
  reasoning,
  reasoningLevels,
  onReasoningChange,
  approvalMode,
  onApprovalModeChange,
  busy,
  onStop,
  engineUp,
  focusTick,
  designOn,
  designBusy,
  onToggleDesign,
}: {
  value: string
  onChange: (next: string) => void
  onSend: (text: string) => void
  model: string
  models: ModelInfo[]
  onModelChange: (next: string) => void
  reasoning: string
  reasoningLevels: string[]
  onReasoningChange: (next: string) => void
  approvalMode: string
  onApprovalModeChange: (next: string) => void
  busy: boolean
  onStop: () => void
  engineUp: boolean
  focusTick: number
  designOn: boolean
  designBusy: boolean
  onToggleDesign: () => void
}) {
  const composerRef = useRef<PublicInstance | null>(null)
  const { renderer } = useGpuix()
  useEffect(() => {
    const id = composerRef.current?.id
    if (id == null) return
    renderer?.focusElement?.(id)
  }, [focusTick, renderer])
  const ready = engineUp && value.trim().length > 0
  const send = (text: string) => {
    const next = text.trim()
    if (!next || !engineUp) return
    onSend(next)
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flexShrink: 0,
        paddingLeft: 20,
        paddingRight: 20,
        overflow: 'visible',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: CONTENT_MAX_WIDTH,
          overflow: 'visible',
          backgroundColor: C.composer,
          borderRadius: 13,
          borderWidth: 1,
          borderColor: C.border,
          paddingTop: 10,
          paddingBottom: 10,
        }}
      >
        <textarea
          ref={composerRef}
          testId="composer"
          value={value}
          placeholder={engineUp ? 'Do anything...' : 'Engine unreachable…'}
          minRows={1}
          maxRows={3}
          autoFocus
          theme={currentTheme()}
          style={{
            width: '100%',
            minWidth: 0,
            ...UI_TEXT,
            color: C.text,
            backgroundColor: '#00000000',
            borderWidth: 0,
            paddingLeft: 10,
            paddingRight: 10,
          }}
          onChange={(event) => onChange(event.value ?? '')}
          onSubmit={(event) => send(event.value ?? value)}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            marginTop: 8,
            paddingLeft: 10,
            paddingRight: 10,
          }}
        >
          <ModelPicker value={model} models={models} onChange={onModelChange} />
          <ReasoningPicker value={reasoning} levels={reasoningLevels} onChange={onReasoningChange} />
          <AccessPicker value={approvalMode} onChange={onApprovalModeChange} />
          <DesignToggle on={designOn} busy={designBusy} onToggle={onToggleDesign} />
          <div style={{ flexGrow: 1 }} />
          <div
            testId={busy ? 'stop-message' : 'send-message'}
            role="button"
            aria-label={busy ? 'Stop the running turn' : 'Send message'}
            tabIndex={0}
            onClick={() => (busy ? onStop() : send(value))}
            onKeyDown={(event: { key?: string }) => {
              if (event.key === 'enter' || event.key === ' ') busy ? onStop() : send(value)
            }}
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: busy || ready ? 'pointer' : undefined,
              backgroundColor: busy ? C.error : ready ? C.inverse : C.overlayStrong,
              hover: busy || ready ? { opacity: 0.9 } : undefined,
            }}
          >
            {busy ? (
              <Icon name="stop" size={12} color={C.onInverse} />
            ) : (
              <Icon name="send" size={16} color={ready ? C.onInverse : C.ghost} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The row under an assistant answer.
 *
 * Copy only. The thumbs were inherited from the chat example's chrome and have
 * no behaviour behind them: the rating was never sent anywhere, so the button
 * was decoration that looked like a control — worse than no control at all.
 */
function ActionBar({ text, onCopy }: { text: string; onCopy: (text: string) => Promise<void> }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 4,
        paddingTop: 6,
        marginLeft: -7,
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {/* Copies the response as markdown, which is what a reader pasting it
            into an issue or a doc actually wants — not the rendered text. */}
        <CopyButton text={text} label="response" testId="copy-response" onCopy={onCopy} />
      </div>
    </div>
  )
}

type MdxChildren = { children?: React.ReactNode }

function flattenMdxTable(children: React.ReactNode): {
  cols: number
  cells: React.ReactElement[]
} {
  const rows: React.ReactElement[][] = []
  React.Children.forEach(children, (section) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(section)) return
    React.Children.forEach(section.props.children, (row) => {
      if (!React.isValidElement<{ children?: React.ReactNode }>(row)) return
      const cells: React.ReactElement[] = []
      React.Children.forEach(row.props.children, (cell) => {
        if (React.isValidElement(cell)) cells.push(cell)
      })
      if (cells.length > 0) rows.push(cells)
    })
  })
  const cols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const cells: React.ReactElement[] = []
  for (const [rowIndex, row] of rows.entries()) {
    for (let col = 0; col < cols; col++) {
      cells.push(
        col < row.length
          ? React.cloneElement(row[col]!, { key: `${rowIndex}-${col}` })
          : <div key={`pad-${rowIndex}-${col}`} />
      )
    }
  }
  return { cols, cells }
}

function MdxCell({ children, header }: MdxChildren & { header?: boolean }) {
  return (
    <div
      testId="mdx-cell"
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'nowrap',
        padding: 8,
        minWidth: 96,
        flexShrink: 0,
        ...TABLE_CELL,
        backgroundColor: C.canvas,
        fontSize: 15,
        lineHeight: 26,
        fontWeight: header ? 700 : 400,
        color: C.text,
      }}
    >
      {children}
    </div>
  )
}

function MdxBlock({ children }: MdxChildren) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', minWidth: 0 }}>
      {children}
    </div>
  )
}

const MD_TEXT: StyleDesc = {
  fontSize: 15,
  lineHeight: 26,
  color: C.text,
  maxWidth: '100%',
  minWidth: 0,
}

function MdxInline({ children, style }: MdxChildren & { style?: StyleDesc }) {
  return <text style={{ ...MD_TEXT, ...style }}>{children}</text>
}

function mdxStringChild(children: React.ReactNode) {
  const items = React.Children.toArray(children)
  if (items.length === 1 && (typeof items[0] === 'string' || typeof items[0] === 'number')) {
    return items[0]
  }
  return null
}

function MdxParagraph({ children }: MdxChildren) {
  const only = mdxStringChild(children)
  if (only != null) {
    return <text style={{ ...MD_TEXT, width: '100%' }}>{only}</text>
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'start',
        width: '100%',
        minWidth: 0,
        fontSize: 15,
        lineHeight: 26,
        color: C.text,
      }}
    >
      {React.Children.map(children, (child) =>
        typeof child === 'string' || typeof child === 'number' ? (
          <text style={MD_TEXT}>{child}</text>
        ) : (
          child
        ),
      )}
    </div>
  )
}

const SAFE_MDX_COMPONENTS = {
  h1: ({ children }: MdxChildren) => (
    <text style={{ fontSize: 22, lineHeight: 30, fontWeight: 700, color: C.text, maxWidth: '100%', minWidth: 0 }}>
      {children}
    </text>
  ),
  h2: ({ children }: MdxChildren) => (
    <text style={{ fontSize: 18, lineHeight: 26, fontWeight: 700, color: C.text, maxWidth: '100%', minWidth: 0 }}>
      {children}
    </text>
  ),
  h3: ({ children }: MdxChildren) => (
    <text style={{ fontSize: 16, lineHeight: 24, fontWeight: 700, color: C.text, maxWidth: '100%', minWidth: 0 }}>
      {children}
    </text>
  ),
  h4: MdxInline,
  h5: MdxInline,
  h6: MdxInline,
  p: MdxParagraph,
  blockquote: ({ children }: MdxChildren) => (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 12, width: '100%', minWidth: 0 }}>
      <div style={{ width: 3, flexShrink: 0, backgroundColor: C.accent }} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, gap: 6, color: C.secondary }}>
        {children}
      </div>
    </div>
  ),
  hr: () => <div style={{ height: 1, width: '100%', backgroundColor: C.border }} />,
  ul: MdxBlock,
  ol: MdxBlock,
  li: ({
    children,
    'data-checked': checked,
  }: MdxChildren & { 'data-checked'?: boolean }) => {
    const only = mdxStringChild(children)
    return (
      <div style={{ display: 'flex', flexDirection: 'row', gap: 9, width: '100%', minWidth: 0 }}>
        <text style={{ fontSize: 15, lineHeight: 26, color: C.secondary, flexShrink: 0 }}>
          {checked === undefined ? '•' : checked ? '✓' : '○'}
        </text>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          {only != null ? <text style={{ ...MD_TEXT, width: '100%' }}>{only}</text> : children}
        </div>
      </div>
    )
  },
  strong: ({ children }: MdxChildren) => <MdxInline style={{ fontWeight: 700 }}>{children}</MdxInline>,
  em: ({ children }: MdxChildren) => <MdxInline style={{ color: C.secondary }}>{children}</MdxInline>,
  del: ({ children }: MdxChildren) => <MdxInline style={{ color: C.muted }}>{children}</MdxInline>,
  code: ({ children }: MdxChildren) => (
    <MdxInline
      style={{
        fontFamily: FONT_MONO,
        backgroundColor: C.raised,
        borderRadius: 5,
        paddingLeft: 5,
        paddingRight: 5,
        ...CODE_INLINE,
      }}
    >
      {children}
    </MdxInline>
  ),
  a: ({ children }: MdxChildren & { href?: string }) => (
    <MdxInline style={{ color: C.accent }}>{children}</MdxInline>
  ),
  table: ({ children }: MdxChildren) => {
    const { cols, cells } = flattenMdxTable(children)
    if (cols === 0) return null
    return (
      <div
        testId="mdx-table"
        style={{ display: 'flex', width: '100%', minWidth: 0, ...TABLE_SCROLL }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            gridColumnMin: 'max-content',
            flexShrink: 0,
            backgroundColor: C.border,
            rowGap: 1,
            columnGap: 1,
          }}
        >
          {cells}
        </div>
      </div>
    )
  },
  thead: MdxBlock,
  tbody: MdxBlock,
  tr: ({ children }: MdxChildren) => <>{children}</>,
  th: ({ children }: MdxChildren) => <MdxCell header>{children}</MdxCell>,
  td: ({ children }: MdxChildren) => <MdxCell>{children}</MdxCell>,
  Callout: ({ children, title }: MdxChildren & { title?: string }) => (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: '100%',
        padding: 12,
        backgroundColor: C.raised,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: C.border,
      }}
    >
      <text style={{ fontSize: 13, fontWeight: 700, color: C.accent }}>{title}</text>
      {children}
    </div>
  ),
}

const mdxCache = new Map<string, Root>()

/** Marks a source that does not parse, so the fallback is not re-attempted. */
const mdxBroken = new Set<string>()

/**
 * Parses markdown, or reports that it could not.
 *
 * MDX is strict: an unclosed inline tag is a hard parse error, not a warning.
 * A streaming answer is a partial document by definition — a block can end
 * mid-`<span>` — so a throw here is expected traffic, not an exception. The
 * caller renders the source as plain text instead, which is honest about what
 * arrived rather than blanking the transcript.
 */
function parseMdx(source: string): Root | null {
  const cached = mdxCache.get(source)
  if (cached) return cached
  if (mdxBroken.has(source)) return null
  let tree: Root
  try {
    tree = mdxParse(source)
  } catch {
    mdxBroken.add(source)
    return null
  }
  mdxCache.set(source, tree)
  return tree
}

export function SafeMdxContent({
  source,
  onLinkClick,
  onCopy,
}: {
  source: string
  onLinkClick?: (href: string) => void
  onCopy: (text: string) => Promise<void>
}) {
  const mdast = useMemo(() => parseMdx(source), [source])
  const components = useMemo(
    () =>
      onLinkClick
        ? {
            ...SAFE_MDX_COMPONENTS,
            a: ({ children, href }) => (
              <div
                style={{ display: 'flex', flexDirection: 'row', cursor: href ? 'pointer' : undefined }}
                onClick={() => href && onLinkClick(href)}
              >
                <MdxInline style={{ color: C.accent }}>{children}</MdxInline>
              </div>
            ),
          }
        : SAFE_MDX_COMPONENTS,
    [onLinkClick]
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%', minWidth: 0 }}>
      {mdast ? (
        <SafeMdxRenderer
          markdown={source}
          mdast={mdast}
          components={components}
          renderNode={(node) => {
            if (node.type !== 'code') return undefined
            return <CodeBlock code={node.value} language={node.lang ?? undefined} showLineNumbers onCopy={onCopy} />
          }}
        />
      ) : (
        // The source does not parse — normally a partial document mid-stream.
        // Showing it verbatim keeps the text readable and keeps a malformed
        // answer from taking down the window.
        <text style={{ fontSize: 13, lineHeight: 20, color: C.secondary, whiteSpace: 'normal', width: '100%' }}>
          {source}
        </text>
      )}
    </div>
  )
}

export function SafeMdxTranscript({ onCopy }: { onCopy: (text: string) => Promise<void> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30, width: 748 }}>
      <UserTurn text="Can Markdown be composed as normal React elements instead?" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <SafeMdxContent source={SAFE_MDX_STRESS} onCopy={onCopy} />
        <ActionBar text={SAFE_MDX_STRESS} onCopy={onCopy} />
      </div>
    </div>
  )
}

export interface DiffFile {
  path: string
  oldText: string
  newText: string
  added: number
  removed: number
}

/**
 * Splits a unified diff into one raw patch chunk per file, keyed by path.
 * Each chunk still starts at its own `diff --git` header so it can be fed
 * straight to <diff>. Selecting a file in the list narrows the viewer to that
 * file without re-reading the patch.
 */
export function splitPatchByFile(patch: string): Map<string, string> {
  const out = new Map<string, string>()
  let cur: { path: string; lines: string[] } | null = null
  const flush = () => {
    if (cur) out.set(cur.path, cur.lines.join('\n'))
    cur = null
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      const parts = line.split(' ')
      const b = parts[3] ?? parts[2] ?? ''
      cur = { path: b.replace(/^b\//, ''), lines: [line] }
      continue
    }
    if (!cur) continue
    cur.lines.push(line)
  }
  flush()
  return out
}

/**
 * Splits a unified diff into per-file old/new texts for the side-by-side
 * layout. Pure, so the reconstruction is testable without a renderer.
 */
export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: { path: string; oldLines: string[]; newLines: string[]; added: number; removed: number } | null = null
  const flush = () => {
    if (cur) {
      files.push({ path: cur.path, oldText: cur.oldLines.join('\n'), newText: cur.newLines.join('\n'), added: cur.added, removed: cur.removed })
      cur = null
    }
  }
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush()
      const parts = line.split(' ')
      const b = parts[3] ?? parts[2] ?? ''
      cur = { path: b.replace(/^b\//, ''), oldLines: [], newLines: [], added: 0, removed: 0 }
      continue
    }
    if (!cur) continue
    if (
      line.startsWith('@@') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('index ') ||
      line.startsWith('new file ') ||
      line.startsWith('deleted ') ||
      line.startsWith('similarity ') ||
      line.startsWith('rename ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('\\')
    ) {
      continue
    }
    const marker = line[0]
    const text = line.slice(1)
    if (marker === ' ') {
      cur.oldLines.push(text)
      cur.newLines.push(text)
    } else if (marker === '-') {
      cur.oldLines.push(text)
      cur.removed++
    } else if (marker === '+') {
      cur.newLines.push(text)
      cur.added++
    }
  }
  flush()
  return files
}

function DiffOverlay({
  open,
  onClose,
  patch,
  defaultCollapsed,
  layout,
  onLayoutChange,
}: {
  open: boolean
  onClose: () => void
  patch: string
  defaultCollapsed: boolean
  layout: 'stacked' | 'side-by-side'
  onLayoutChange: (next: 'stacked' | 'side-by-side') => void
}) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    if (files.length && !selected) setSelected(files[0]!.path)
    if (files.length && selected && !files.find(f => f.path === selected)) setSelected(files[0]!.path)
    if (!files.length) setSelected(null)
  }, [files, selected])
  const [collapsed, setCollapsed] = useState<string[] | null>(null)
  useEffect(() => {
    setCollapsed(null)
  }, [patch])
  const effectiveCollapsed = collapsed ?? (defaultCollapsed ? files.map((f) => f.path) : [])
  const togglePath = (path: string) => {
    const base = collapsed ?? (defaultCollapsed ? files.map((f) => f.path) : [])
    setCollapsed(base.includes(path) ? base.filter((p) => p !== path) : [...base, path])
  }
  return (
    <Dialog open={open} onOpenChange={(next: boolean) => !next && onClose()}>
      <DialogPortal>
        <DialogBackdrop style={{ backgroundColor: '#00000066' }} />
        <DialogPopup
          style={{
            width: 860,
            maxWidth: '92%',
            maxHeight: '84%',
            backgroundColor: C.raised,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: C.borderStrong,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <DialogTitle style={{ flexGrow: 1 }}>
              <text style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                Uncommitted changes
              </text>
            </DialogTitle>
            <div
              testId="diff-layout-toggle"
              role="radiogroup"
              aria-label="Diff layout"
              style={{
                display: 'flex',
                flexDirection: 'row',
                borderWidth: 1,
                borderColor: C.borderStrong,
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              {(['stacked', 'side-by-side'] as const).map((option) => (
                <div
                  key={option}
                  testId={`diff-layout-${option}`}
                  role="radio"
                  aria-checked={layout === option}
                  aria-label={option === 'stacked' ? 'Stacked' : 'Side by side'}
                  tabIndex={0}
                  onClick={() => onLayoutChange(option)}
                  onKeyDown={(event: { key?: string }) => {
                    if (event.key === 'enter' || event.key === ' ') onLayoutChange(option)
                  }}
                  style={{
                    paddingLeft: 10,
                    paddingRight: 10,
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    backgroundColor: layout === option ? C.overlayStrong : '#00000000',
                  }}
                >
                  <text style={{ fontSize: 12.5, color: layout === option ? C.text : C.secondary }}>
                    {option === 'stacked' ? 'Stacked' : 'Side by side'}
                  </text>
                </div>
              ))}
            </div>
            <Button
              testId="diff-expand-all"
              aria-label="Expand all files"
              onClick={() => setCollapsed([])}
              style={{
                height: 28,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                hover: { backgroundColor: C.overlay },
              }}
            >
              <text style={{ fontSize: 12.5, color: C.secondary }}>Expand all</text>
            </Button>
            <Button
              testId="diff-collapse-all"
              aria-label="Collapse all files"
              onClick={() => setCollapsed(files.map((f) => f.path))}
              style={{
                height: 28,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                hover: { backgroundColor: C.overlay },
              }}
            >
              <text style={{ fontSize: 12.5, color: C.secondary }}>Collapse all</text>
            </Button>
            <DialogClose
              testId="diff-close"
              style={{
                height: 28,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                hover: { backgroundColor: C.overlay },
              }}
            >
              <text style={{ fontSize: 12.5, color: C.secondary }}>Close</text>
            </DialogClose>
          </div>
          <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll' }}>
            {files.length === 0 ? (
              <text style={{ fontSize: 13, color: C.tertiary }}>No uncommitted changes.</text>
            ) : layout === 'stacked' ? (
              <diff
                patch={patch}
                wordDiff
                collapsedPaths={effectiveCollapsed}
                onToggleFile={(event) => togglePath(event.value ?? '')}
                theme={currentTheme()}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {files.map((file) => (
                  <div key={file.path} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Button
                      testId={`diff-file-${file.path}`}
                      aria-expanded={!effectiveCollapsed.includes(file.path)}
                      onClick={() => togglePath(file.path)}
                      style={{
                        display: 'flex',
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        cursor: 'pointer',
                      }}
                    >
                      <Icon
                        name={effectiveCollapsed.includes(file.path) ? 'chevronRight' : 'chevronDown'}
                        size={11.5}
                        color={C.tertiary}
                      />
                      <text style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>
                        {file.path}
                      </text>
                    </Button>
                    {!effectiveCollapsed.includes(file.path) && (
                      <div style={{ display: 'flex', flexDirection: 'row', gap: 8, minWidth: 0 }}>
                        <div style={{ flexGrow: 1, minWidth: 0, overflowX: 'scroll' }}>
                          <div
                            style={{
                              paddingLeft: 8,
                              paddingBottom: 4,
                            }}
                          >
                            <text style={{ fontSize: 11.5, color: C.muted }}>Before</text>
                          </div>
                          <code code={file.oldText} theme={currentTheme()} style={CODE_BODY_STYLE} />
                        </div>
                        <div style={{ flexGrow: 1, minWidth: 0, overflowX: 'scroll' }}>
                          <div
                            style={{
                              paddingLeft: 8,
                              paddingBottom: 4,
                            }}
                          >
                            <text style={{ fontSize: 11.5, color: C.muted }}>After</text>
                          </div>
                          <code code={file.newText} theme={currentTheme()} style={CODE_BODY_STYLE} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  )
}


/**
 * Why committing is unavailable right now, or null when it is.
 *
 * This is presentation policy, not git behaviour, so it lives beside the
 * button it explains rather than in the engine. The engine answers "did the
 * commit happen"; only the UI can answer "why not, in a sentence a person can
 * act on" — which is the part that turns a dead button into a next step.
 */
export function commitBlockedReason(vcs: VcsStatus): string | null {
  if (!vcs.isRepo) return 'This folder is not a git repository.'
  if (vcs.staged.length === 0) {
    return vcs.unstaged.length === 0
      ? 'Nothing to commit.'
      : 'Stage at least one file to commit.'
  }
  return null
}

function ChangesPanel({
  vcs,
  vcsError,
  selectedPath,
  onSelectPath,
  onStage,
  onUnstage,
  onCommit,
  maxHeight,
}: {
  vcs: VcsStatus
  vcsError: string | null
  selectedPath: string | null
  onSelectPath: (path: string | null) => void
  onStage: (paths?: string[]) => void
  onUnstage: (paths?: string[]) => void
  onCommit: (message: string, paths?: string[]) => void
  maxHeight: string
}) {
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState({ staged: true, unstaged: true })
  const [showCommitBox, setShowCommitBox] = useState(false)
  const blocked = commitBlockedReason(vcs)

  // Both callbacks refresh through the parent, so the list below re-reads from
  // the engine rather than guessing at the new state.
  const commit = (paths?: string[]) => {
    const text = message.trim()
    if (!text) return
    onCommit(text, paths)
    setMessage('')
    setShowCommitBox(false)
  }

  if (!vcs.isRepo) {
    return (
      <div
        testId="git-not-a-repo"
        style={{
          flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4,
          backgroundColor: C.raised, borderWidth: 1, borderColor: C.border,
          borderRadius: 10, padding: 12,
        }}
      >
        <text style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Not a git repository</text>
        <text style={{ fontSize: 11.5, color: C.tertiary }}>Source control needs a git work tree in this folder.</text>
      </div>
    )
  }

  const toggle = (key: 'staged' | 'unstaged') =>
    setExpanded(prev => ({ ...prev, [key]: !prev[key] }))

  const section = (
    key: 'staged' | 'unstaged',
    label: string,
    files: VcsFileStatus[],
    action: (paths?: string[]) => void,
  ) => {
    if (files.length === 0) return null
    const open = expanded[key]
    // The section is capped and the rows scroll inside it. Without a cap a
    // 49-file change set expands to the full panel height, pushes the commit
    // box and the diff out of view, and the user cannot reach either. The
    // header stays put because it is a sibling of the scroller, not a row in it.
    return (
      <div
        testId={`git-section-${key}`}
        style={{ display: 'flex', flexDirection: 'column', flexShrink: 1, minHeight: 0, backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 10, overflow: 'hidden' }}
      >
        <div
          testId={`git-section-${key}-toggle`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          onClick={() => toggle(key)}
          onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') toggle(key) }}
          style={{
            display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6,
            height: 28, paddingLeft: 8, paddingRight: 8,
            backgroundColor: C.composer, cursor: 'pointer', hover: { backgroundColor: C.overlay },
          }}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={10} color={C.tertiary} />
          <text style={{ fontSize: 11.5, fontWeight: 600, color: C.text }}>{label}</text>
          <text style={{ fontSize: 11, color: C.tertiary }}>{String(files.length)}</text>
          <div style={{ flexGrow: 1 }} />
          <div
            testId={`git-section-${key}-all`}
            role="button"
            tabIndex={0}
            aria-label={key === 'staged' ? `Unstage all ${label.toLowerCase()}` : `Stage all ${label.toLowerCase()}`}
            onClick={() => action()}
            onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') action() }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: 20, paddingLeft: 6, paddingRight: 6, borderRadius: 5,
              cursor: 'pointer', hover: { backgroundColor: C.overlay },
            }}
          >
            <text style={{ fontSize: 11, color: C.secondary }}>{key === 'staged' ? 'Unstage all' : 'Stage all'}</text>
          </div>
        </div>
        {open && (
        <div
          testId={`git-section-${key}-list`}
          style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll' }}
        >
          {files.map(f => {
            const isSelected = selectedPath === f.path
            return (
          <div
            key={`${key}:${f.path}`}
            testId={`git-file-${f.path}`}
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            onClick={() => onSelectPath(isSelected ? null : f.path)}
            onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') onSelectPath(isSelected ? null : f.path) }}
            style={{
              display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6,
              height: 24, paddingLeft: 22, paddingRight: 8,
              backgroundColor: isSelected ? C.overlayStrong : 'transparent',
              hover: { backgroundColor: isSelected ? C.overlayStrong : C.overlay },
            }}
          >
            <Icon name="file" size={11} color={f.untracked ? C.success : C.tertiary} />
            <text style={{ fontSize: 11.5, color: C.secondary, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{f.path}</text>
            {f.insertions > 0 && <text style={{ fontSize: 10.5, color: C.success }}>{`+${f.insertions}`}</text>}
            {f.deletions > 0 && <text style={{ fontSize: 10.5, color: C.error }}>{`-${f.deletions}`}</text>}
            <div
              testId={`git-file-action-${f.path}`}
              role="button"
              tabIndex={0}
              aria-label={key === 'staged' ? `Unstage ${f.path}` : `Stage ${f.path}`}
              onClick={() => action([f.path])}
              onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') action([f.path]) }}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 18, height: 18, borderRadius: 4, cursor: 'pointer', hover: { backgroundColor: C.overlayStrong },
              }}
            >
              <text style={{ fontSize: 12, fontWeight: 600, color: C.secondary }}>{key === 'staged' ? '\u2212' : '+'}</text>
            </div>
          </div>
            )
          })}
        </div>
        )}
      </div>
    )
  }

  return (
    // flexShrink 1 with a min height, so the file lists take the space they need
    // and hand the rest back to the diff below instead of growing unbounded.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 1, minHeight: 0, maxHeight }}>
      {vcsError && (
        <div
          testId="git-error"
          role="alert"
          style={{
            display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0,
            backgroundColor: C.raised, borderWidth: 1, borderColor: C.error,
            borderRadius: 10, padding: 8,
          }}
        >
          <text style={{ fontSize: 11, fontWeight: 600, color: C.error }}>Git action failed</text>
          <text style={{ fontSize: 11, color: C.secondary }}>{vcsError}</text>
        </div>
      )}
      {section('staged', 'Staged', vcs.staged, onUnstage)}
      {section('unstaged', 'Changes', vcs.unstaged, onStage)}

      {/* When nothing is staged there is no control to show — only a reason.
          Rendering that reason inside a bordered card made it look like a
          disabled button, which invited clicking. */}
      {blocked && !showCommitBox ? (
        <div
          testId="git-commit-blocked"
          style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, height: 22, flexShrink: 0, paddingLeft: 4 }}
        >
          <text style={{ fontSize: 11, color: C.muted }}>{blocked}</text>
        </div>
      ) : (
        <div
          testId="git-commit"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 8, flexShrink: 0 }}
        >
          {showCommitBox ? (
            <>
              <input
                testId="git-commit-message"
                aria-label="Commit message"
                placeholder="Commit message"
                value={message}
                onChange={(e: { value?: string }) => setMessage(e.value ?? '')}
                onSubmit={() => commit()}
                style={{
                  height: 28, paddingLeft: 8, paddingRight: 8, borderRadius: 7,
                  backgroundColor: C.canvas, borderWidth: 1, borderColor: C.border,
                  fontSize: 12, color: C.text,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <div
                  testId="git-commit-submit"
                  role="button"
                  tabIndex={0}
                  aria-disabled={message.trim() === ''}
                  onClick={() => commit()}
                  onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') commit() }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, height: 24,
                    paddingLeft: 10, paddingRight: 10, borderRadius: 7,
                    backgroundColor: message.trim() === '' ? C.raised : C.accent,
                    borderWidth: 1, borderColor: message.trim() === '' ? C.border : 'transparent',
                    cursor: message.trim() === '' ? 'default' : 'pointer',
                  }}
                >
                  <Icon name="check" size={11} color={message.trim() === '' ? C.ghost : '#1C1916'} />
                  <text style={{ fontSize: 11.5, fontWeight: 600, color: message.trim() === '' ? C.muted : '#1C1916' }}>Commit staged</text>
                </div>
                <div
                  testId="git-commit-cancel"
                  role="button"
                  tabIndex={0}
                  aria-label="Cancel commit"
                  onClick={() => { setShowCommitBox(false); setMessage('') }}
                  onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') { setShowCommitBox(false); setMessage('') } }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
                >
                  <text style={{ fontSize: 13, color: C.secondary }}>{'\u2715'}</text>
                </div>
                <text style={{ fontSize: 10.5, color: C.muted }}>{`${vcs.staged.length} staged`}</text>
              </div>
            </>
          ) : (
            /* Reached only when something is staged: the blocked case renders
               the plain reason above instead, so this is always actionable. */
            <div
              testId="git-commit-open"
              role="button"
              tabIndex={0}
              onClick={() => setShowCommitBox(true)}
              onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') setShowCommitBox(true) }}
              style={{
                display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6,
                height: 24, paddingLeft: 8, paddingRight: 8, borderRadius: 7,
                cursor: 'pointer', hover: { backgroundColor: C.overlay },
              }}
            >
              <Icon name="check" size={11} color={C.secondary} />
              <text style={{ fontSize: 11.5, color: C.secondary }}>Commit staged changes</text>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GitSidebar({
  branch,
  dirty,
  patch,
  branchPatch,
  turnDiffs,
  turnTimes,
  diffSource,
  onDiffSourceChange,
  onRefresh,
  onClose,
  layout,
  onLayoutChange,
  onOpenFullDiff,
  vcs,
  vcsError,
  onStage,
  onUnstage,
  onCommit,
  onFileDiff,
}: {
  branch: string
  dirty: number
  patch: string
  vcs: VcsStatus
  vcsError: string | null
  onStage: (paths?: string[]) => void
  onUnstage: (paths?: string[]) => void
  onCommit: (message: string, paths?: string[]) => void
  branchPatch: string
  turnDiffs: Record<string, string>
  turnTimes: Record<string, number>
  diffSource: string
  onDiffSourceChange: (next: string) => void
  onRefresh: () => void
  onClose: () => void
  layout: 'stacked' | 'side-by-side'
  onLayoutChange: (next: 'stacked' | 'side-by-side') => void
  onOpenFullDiff: () => void
  onFileDiff: (path: string) => Promise<string>
}) {
  // Resolve which patch the viewer shows, from the source dropdown.
  const displayPatch = useMemo(() => {
    const turnIds = Object.keys(turnDiffs).sort((a, b) => (turnTimes[b] ?? 0) - (turnTimes[a] ?? 0))
    if (diffSource === 'branch') return branchPatch || patch
    if (diffSource === 'latest' && turnIds[0]) return turnDiffs[turnIds[0]] ?? patch
    if (diffSource.startsWith('turn:')) return turnDiffs[diffSource.slice(5)] ?? patch
    return patch
  }, [diffSource, branchPatch, patch, turnDiffs, turnTimes])
  const files = useMemo(() => parseUnifiedDiff(displayPatch), [displayPatch])
  const [width, setWidth] = useState(520)
  const winWidth = (() => { try { return (typeof window !== 'undefined' ? window.innerWidth : 1180) } catch { return 1180 } })()
  const maxW = Math.floor(winWidth * 0.75)
  const dragRef = useRef<{ x: number; w: number } | null>(null)
  const [resizing, setResizing] = useState(false)
  // The file list gets a minority of the column by default: it is a reference
  // the user scans, while the diff below is what they actually read.
  const [listPct, setListPct] = useState(34)
  const splitDrag = useRef<{ y: number; pct: number } | null>(null)
  const [splitting, setSplitting] = useState(false)
  // The file whose diff the viewer shows. Selecting a row in the list is the
  // only way to choose what the diff pane displays.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // The selected file's own patch. The whole-tree diff is capped, so a file
  // the user picks may be missing from it entirely; asking the engine for that
  // one file is what makes selection work on a large change set.
  const [fileDiff, setFileDiff] = useState<string | null>(null)
  const [fileDiffLoading, setFileDiffLoading] = useState(false)

  // The caller passes an inline arrow, so its identity changes on every render.
  // Depending on it directly re-ran this effect each time, and since the
  // effect sets state, that re-rendered, which re-ran the effect: an endless
  // refetch loop that showed up as a flickering diff. A ref pins the latest
  // callback while the effect depends only on the selected path.
  const fileDiffRef = useRef(onFileDiff)
  fileDiffRef.current = onFileDiff

  useEffect(() => {
    if (!selectedPath) {
      setFileDiff(null)
      return
    }
    let cancelled = false
    setFileDiffLoading(true)
    void (async () => {
      try {
        const text = await fileDiffRef.current(selectedPath)
        if (!cancelled) setFileDiff(text)
      } catch {
        if (!cancelled) setFileDiff('')
      } finally {
        if (!cancelled) setFileDiffLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedPath])
  return (
    <div
      testId="git-sidebar"
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width,
        flexShrink: 0,
        height: '100%',
        backgroundColor: C.sidebar,
        borderLeftWidth: 1,
        borderColor: C.sidebarBorder,
      }}
    >
      <div
        testId="git-resize-handle"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          backgroundColor: resizing ? C.borderStrong : 'transparent',
          // Dragging a resize handle must not sweep a text selection across the
          // file names behind it. The panel keeps its own userSelect for the
          // content, but the handle opts out for itself and its subtree.
          userSelect: 'none',
        }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Source Control"
        aria-valuenow={width}
        aria-valuemin={280}
        aria-valuemax={maxW}
        tabIndex={0}
        onKeyDown={(e: { key?: string }) => {
          // GPUIX's key payload carries no modifier state, so there is no
          // shift-for-coarse-step; each press is a fixed 12px.
          const step = 12
          if (e.key === 'arrowleft') { setWidth(w => Math.min(maxW, Math.max(280, w - step))); clearTextSelection() }
          if (e.key === 'arrowright') { setWidth(w => Math.min(maxW, Math.max(280, w + step))); clearTextSelection() }
        }}
        onMouseDown={(e: { x?: number }) => {
          // Clear any selection the press already began, so the drag starts on
          // a clean window rather than leaving a wash across the list.
          clearTextSelection()
          dragRef.current = { x: e.x ?? 0, w: width }
          setResizing(true)
        }}
        onMouseMove={(e: { x?: number }) => {
          if (!dragRef.current) return
          const dx = dragRef.current.x - (e.x ?? 0)
          const next = Math.min(maxW, Math.max(280, dragRef.current.w + dx))
          setWidth(next)
        }}
        onMouseUp={() => {
          dragRef.current = null
          setResizing(false)
        }}
        onMouseLeave={() => {
          if (dragRef.current) {
            dragRef.current = null
            setResizing(false)
          }
        }}
      />
      {/* This row *is* the titlebar for this panel, so it matches the chat
          header's height and inset rather than sitting under its own band. The
          traffic lights overlay the thread sidebar, not this edge, so no
          clearance is needed here. */}
      <div
        style={{
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8,
          height: TITLEBAR_HEIGHT, flexShrink: 0, paddingLeft: 14, paddingRight: 12,
          userSelect: 'none',
        }}
      >
        <Icon name="gitBranch" size={14} color={C.tertiary} />
        <text style={{ fontSize: 13, fontWeight: 500, color: C.text, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>Source Control</text>
        <IconButton icon="retry" testId="git-refresh" onClick={onRefresh} />
        <IconButton icon="panelRight" testId="git-close" onClick={onClose} />
      </div>

      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, paddingLeft: 12, paddingRight: 12, paddingBottom: 16, overflow: 'hidden' }}>

        <ChangesPanel
          vcs={vcs}
          vcsError={vcsError}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          onStage={onStage}
          onUnstage={onUnstage}
          onCommit={onCommit}
          maxHeight={`${listPct}%`}
        />

        {/* Drag handle between the file list and the diff. The list is a
            reference the user scans; the diff is what they read. The split is
            draggable because "how much of each" depends on the change set. */}
        {vcs.isRepo ? (
          <div
            testId="git-split-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize file list"
            // Announced as a value so a screen reader user knows how the split
            // is currently set, the same way a native separator reports.
            aria-valuenow={Math.round(listPct)}
            aria-valuemin={12}
            aria-valuemax={80}
            tabIndex={0}
            onMouseDown={(e: { x?: number; y?: number }) => {
              clearTextSelection()
              splitDrag.current = { y: e.y ?? 0, pct: listPct }
              setSplitting(true)
            }}
            onMouseMove={(e: { y?: number }) => {
              const d = splitDrag.current
              if (!d) return
              // The list's bottom edge follows the pointer, so dragging down
              // grows it. The panel-width handle subtracts instead, because its
              // right edge follows the pointer the other way.
              const dy = (e.y ?? 0) - d.y
              setListPct(Math.min(80, Math.max(12, d.pct + (dy / 520) * 100)))
            }}
            onMouseUp={() => { splitDrag.current = null; setSplitting(false) }}
            onMouseLeave={() => { splitDrag.current = null; setSplitting(false) }}
            onKeyDown={(e: { key?: string }) => {
              const step = 4
              if (e.key === 'arrowup') { setListPct(p => Math.max(12, p - step)); clearTextSelection() }
              if (e.key === 'arrowdown') { setListPct(p => Math.min(80, p + step)); clearTextSelection() }
            }}
            style={{
              // 12px tall rather than 8: the visible rule is 2px, but the hit
              // target is the whole strip, and a 2px target is not hittable.
              height: 12,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'row-resize',
              backgroundColor: splitting ? C.borderStrong : 'transparent',
              borderRadius: 6,
              userSelect: 'none',
            }}
          >
            <div style={{ width: 28, height: 2, borderRadius: 1, backgroundColor: splitting ? C.borderStrong : C.border }} />
          </div>
        ) : null}

        {/* Without a repo there is no patch to show, and an empty diff viewer
            reads as "you have no changes" rather than "git is not available
            here". The panel above already says which case this is. */}
        {vcs.isRepo ? (() => {
          const turnIds = Object.keys(turnDiffs).sort((a, b) => (turnTimes[b] ?? 0) - (turnTimes[a] ?? 0))
          const totalAdded = files.reduce((a, f) => a + f.added, 0)
          const totalRemoved = files.reduce((a, f) => a + f.removed, 0)
          return (
            <>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingLeft: 10, paddingRight: 8, height: 32, flexShrink: 0 }}>
                <Select
                  value={diffSource}
                  onValueChange={onDiffSourceChange}
                  items={[
                    { value: 'working-tree', label: 'Working tree' },
                    { value: 'branch', label: 'Branch changes' },
                    { value: 'latest', label: 'Latest turn' },
                    ...turnIds.map(id => ({ value: `turn:${id}`, label: id })),
                  ]}
                  style={{ flexGrow: 1 }}
                >
                  <SelectTrigger
                    testId="diff-source-trigger"
                    style={state => ({
                      display: 'flex',
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                      height: 28,
                      paddingLeft: 8,
                      paddingRight: 8,
                      borderRadius: 7,
                      cursor: 'pointer',
                      backgroundColor: state.open ? C.overlayStrong : '#00000000',
                    })}
                  >
                    <text style={{ fontSize: 12, color: C.text }}>{diffSource === 'working-tree' ? 'Working tree' : diffSource === 'branch' ? 'Branch changes' : diffSource === 'latest' ? 'Latest turn' : diffSource.startsWith('turn:') ? diffSource.slice(5) : diffSource}</text>
                    <Icon name="chevronDown" size={10} color={C.ghost} />
                  </SelectTrigger>
                  <SelectContent side="bottom" sideOffset={4} style={{ ...MENU, minWidth: 220 }}>
                    <SelectItem value="working-tree" testId="diff-source-working-tree" style={s => menuItemStyle(s)}>{s => <MenuRow label="Working tree" selected={s.selected} />}</SelectItem>
                    <SelectItem value="branch" testId="diff-source-branch" style={s => menuItemStyle(s)}>{s => <MenuRow label="Branch changes" selected={s.selected} />}</SelectItem>
                    <SelectItem value="latest" testId="diff-source-latest" style={s => menuItemStyle(s)}>{s => <MenuRow label="Latest turn" selected={s.selected} />}</SelectItem>
                    {turnIds.length > 0 && (
                      <SelectLabel style={{ height: 22, paddingLeft: 8, paddingRight: 8, display: 'flex', alignItems: 'center' }}>
                        <text style={{ fontSize: 11, fontWeight: 500, color: C.muted }}>Turn</text>
                      </SelectLabel>
                    )}
                    {turnIds.map((tid, idx) => {
                      const label = `Turn ${turnIds.length - idx}`
                      const ts = turnTimes[tid]
                      const hint = ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : undefined
                      return (
                        <SelectItem key={tid} value={`turn:${tid}`} testId={`diff-source-turn-${tid}`} style={s => menuItemStyle(s)}>{s => <MenuRow label={label} hint={hint} selected={s.selected} />}</SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                {/* Totals follow the selection: narrowing to one file should
                    narrow the count too, or the bar contradicts the pane. */}
                <text style={{ fontSize: 11, color: C.success }}>
                  {selectedPath
                    ? (() => { const f = files.find(x => x.path === selectedPath); return f?.added ? `+${f.added}` : '' })()
                    : totalAdded ? `+${totalAdded}` : ''}
                </text>
                <text style={{ fontSize: 11, color: C.error }}>
                  {selectedPath
                    ? (() => { const f = files.find(x => x.path === selectedPath); return f?.removed ? `-${f.removed}` : '' })()
                    : totalRemoved ? `-${totalRemoved}` : ''}
                </text>
                {/* The escape hatch from a single-file view. It lives here
                    because the diff pane no longer has a bar of its own. */}
                {selectedPath && (
                  <div
                    testId="git-diff-file-clear"
                    role="button"
                    tabIndex={0}
                    aria-label="Show all files"
                    onClick={() => setSelectedPath(null)}
                    onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') setSelectedPath(null) }}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 5, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
                  >
                    <text style={{ fontSize: 13, color: C.secondary }}>{'×'}</text>
                  </div>
                )}
              </div>
              <div
                testId="git-diff-viewer"
                style={{ backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 10, overflow: 'hidden', flexGrow: 1, minHeight: 0, flexShrink: 1, display: 'flex', flexDirection: 'column' }}
              >
{(() => {
                  // A selected file is driven by its own fetched patch, so the
                  // tree-level "nothing here" state must not pre-empt it.
                  if (files.length === 0 && !selectedPath) {
                    // Distinguish a clean tree from a selected scope that has no
                    // changes. "No changes" next to a list of 49 changed files
                    // reads as a contradiction; the scope is what was asked for.
                    const scopeLabel =
                      diffSource === 'branch' ? 'Branch changes'
                      : diffSource === 'latest' ? 'The latest turn'
                      : diffSource.startsWith('turn:') ? 'That turn'
                      : 'The working tree'
                    return (
                      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <text style={{ fontSize: 12, color: C.tertiary }}>{`No changes in ${scopeLabel.toLowerCase()}.`}</text>
                        {vcs.hasChanges && (
                          <text style={{ fontSize: 11, color: C.muted }}>
                            Your changes are listed above — pick a file to stage it.
                          </text>
                        )}
                      </div>
                    )
                  }
                  // A selected file shows that file's own patch, fetched on
                  // demand. Falling back to the tree diff alone would leave a
                  // file outside the truncation window showing nothing. The
                  // header is left intact: <diff> draws it, so stripping it
                  // would leave the hunks with no file name at all.
                  const selectedChunk = fileDiff
                  const shownFiles = selectedPath
                    ? files.filter(f => f.path === selectedPath)
                    : files
                  const shownAdded = shownFiles.reduce((a, f) => a + f.added, 0)
                  const shownRemoved = shownFiles.reduce((a, f) => a + f.removed, 0)
                  if (selectedPath && fileDiffLoading) {
                    return (
                      <div style={{ padding: 12 }}>
                        <text style={{ fontSize: 12, color: C.muted }}>{`Loading ${selectedPath}…`}</text>
                      </div>
                    )
                  }
                  if (selectedPath && !selectedChunk) {
                    return (
                      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <text style={{ fontSize: 12, color: C.tertiary }}>{`No diff for ${selectedPath}.`}</text>
                        <text style={{ fontSize: 11, color: C.muted }}>
                          The file may be binary, or unchanged since the last commit.
                        </text>
                      </div>
                    )
                  }
                  return (
                    <>
                    {/* No file-name bar here. <diff> renders its own header for
                        the patch it is given, and the patch's header is what
                        names the file, so a bar above it printed the name
                        twice. The per-file +N -N lives in the scope bar above
                        instead, where it does not compete with the hunks. */}
                    <diff
                      testId="git-diff-body"
                      patch={selectedChunk ?? displayPatch}
                      wordDiff
                      scroll
                      maxLines={4000}
                      // `scroll` makes <diff> its own virtualized scroller, which
                      // requires a bounded height. It has to be on the element
                      // itself, not a wrapper — without it the diff paints nothing.
                      style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
                      theme={currentTheme()}
                    />
                    </>
                  )
                })()}
              </div>
            </>
          )
        })() : null}
      </div>
    </div>
  )
}


function TurnDiff({ patch, onOpenDiff }: { patch: string; onOpenDiff?: () => void }) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch])
  const totalAdded = files.reduce((a, f) => a + f.added, 0)
  const totalRemoved = files.reduce((a, f) => a + f.removed, 0)
  // Group by top-level folder, like t3code's 5 changed files card
  const folders = useMemo(() => {
    const map = new Map<string, { files: typeof files; added: number; removed: number }>()
    for (const f of files) {
      const top = f.path.includes('/') ? f.path.split('/')[0]! : f.path
      const entry = map.get(top) ?? { files: [], added: 0, removed: 0 }
      entry.files.push(f)
      entry.added += f.added
      entry.removed += f.removed
      map.set(top, entry)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [files])
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const toggleFolder = (name: string) => {
    setOpenFolders(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%', backgroundColor: C.raised, borderWidth: 1, borderColor: C.border, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, height: 36, backgroundColor: C.composer, borderBottomWidth: 1, borderColor: C.border }}>
        <text style={{ fontSize: 12, fontWeight: 600, color: C.text, flexGrow: 1 }}>{`${files.length} changed files`}</text>
        <text style={{ fontSize: 11, color: C.success }}>{`+${totalAdded}`}</text>
        <text style={{ fontSize: 11, color: C.error }}>{`-${totalRemoved}`}</text>
        <SettingsButton testId="turn-open-diff" label="Open diff" onClick={() => onOpenDiff?.()} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', padding: 6, gap: 2 }}>
        {folders.map(([folder, data]) => {
          const isOpen = openFolders.has(folder)
          return (
            <div key={folder} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div
                testId={`turn-folder-${folder}`}
                role="button"
                tabIndex={0}
                onClick={() => toggleFolder(folder)}
                onKeyDown={(e: { key?: string }) => { if (e.key === 'enter' || e.key === ' ') toggleFolder(folder) }}
                style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, height: 26, paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}
              >
                <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={10} color={C.tertiary} />
                <Icon name="folder" size={12} color={C.tertiary} />
                <text style={{ fontSize: 12, color: C.text, flexGrow: 1 }}>{folder}</text>
                <text style={{ fontSize: 11, color: C.success }}>{`+${data.added}`}</text>
                <text style={{ fontSize: 11, color: C.error }}>{`-${data.removed}`}</text>
              </div>
              {isOpen && data.files.map(f => (
                <div key={f.path} testId={`turn-file-${f.path}`} role="button" tabIndex={0} onClick={() => onOpenDiff?.()} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, height: 24, paddingLeft: 32, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: C.overlay } }}>
                  <Icon name="file" size={10} color={C.tertiary} />
                  <text style={{ fontSize: 11, color: C.secondary, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{f.path.split('/').pop()}</text>
                  <text style={{ fontSize: 10, color: C.success }}>{f.added ? `+${f.added}` : ''}</text>
                  <text style={{ fontSize: 10, color: C.error }}>{f.removed ? `-${f.removed}` : ''}</text>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function ChatApp({ client: providedClient }: { client?: AgentClient } = {}) {
  const client = useMemo(
    () => providedClient ?? createEscapeAgentClient(),
    [providedClient],
  )
  useEffect(() => () => client.close(), [client])

  const [settings, setSettings] = useState<SettingsState>({ ...DEFAULT_SETTINGS })
  const updateSettings = (patch: Partial<SettingsState>) =>
    setSettings((current) => ({ ...current, ...patch }))
  // Installed families, loaded once in the background. Until they land the
  // pickers show the curated fallbacks, so the screen never blocks on a
  // fontconfig scan.
  const [sysFonts, setSysFonts] = useState<SystemFonts | null>(null)
  useEffect(() => {
    let live = true
    void systemFonts().then((fonts) => {
      if (live && fonts) setSysFonts(fonts)
    })
    return () => {
      live = false
    }
  }, [])
  const sansOptions = sysFonts?.sans ?? SANS_FONTS
  const monoOptions = sysFonts?.mono ?? MONO_FONTS
  const sansFamily =
    sansOptions.find((f) => f.id === settings.sansId)?.family ?? sansOptions[0]?.family ?? 'Helvetica'
  const monoFamily =
    monoOptions.find((f) => f.id === settings.monoId)?.family ?? monoOptions[0]?.family ?? 'Menlo'
  applyAppearance(settings.theme, sansFamily, monoFamily)
  applyTypography(settings.sansSize, settings.monoSize, settings.lineHeight, settings.wordWrap)

  const [engineUp, setEngineUp] = useState(false)
  const [engineError, setEngineError] = useState('')
  const [startDir, setStartDir] = useState('')
  const [startDirError, setStartDirError] = useState('')
  // Why the last submit did nothing. Distinct from an engine error: nothing
  // broke, the prompt simply was not sendable, and saying so beats silence.
  const [submitNotice, setSubmitNotice] = useState('')
  // Design Mode is the shell's own mode, not a flag on a normal turn. It has
  // its own send path because a design run reports phases over minutes and the
  // transcript's per-turn machinery has nothing to say about a repair pass.
  const [designOn, setDesignOn] = useState(false)
  const [designPhases, setDesignPhases] = useState<DesignPhase[]>([])
  const [designOutcome, setDesignOutcome] = useState<DesignOutcome | null>(null)
  const [designBusy, setDesignBusy] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [model, setModelState] = useState('')
  const [provider, setProviderState] = useState('')
  const [reasoning, setReasoningState] = useState('')
  const [reasoningLevels, setReasoningLevels] = useState<string[]>([])
  const [approvalMode, setApprovalModeState] = useState('auto')
  const [followUp, setFollowUpState] = useState<'queue' | 'steer'>('queue')
  const [textModel, setTextModelState] = useState('')
  const [apiBaseURL, setApiBaseURL] = useState('')
  const [providerError, setProviderError] = useState('')
  const [cwd, setCwd] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  // ── Git integration (t3code-inspired: branch + dirty live from cwd) ──
  const [gitBranch, setGitBranch] = useState('')
  const [gitDirty, setGitDirty] = useState(0)
  // The engine's view of the working tree. Source of truth for the sidebar's
  // staged/unstaged lists; the header chip reads the counts off it.
  const [vcs, setVcs] = useState<VcsStatus>({
    isRepo: true, refName: '', hasChanges: false, staged: [], unstaged: [],
    insertions: 0, deletions: 0,
  })
  const [vcsError, setVcsError] = useState<string | null>(null)
  // A git mutation invalidates both the working-tree lists and the patch, so
  // one refresh covers the whole sidebar. The error is kept because a failed
  // stage or commit leaves the tree in a state the user did not expect, and
  // silently doing nothing is the worst possible answer.
  const runVcs = async (action: () => Promise<void>) => {
    setVcsError(null)
    try {
      await action()
    } catch (err) {
      setVcsError(err instanceof Error ? err.message : String(err))
    }
    await refreshGit()
  }
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false)
  const [turnDiffs, setTurnDiffs] = useState<Record<string, string>>({})
  const [turnTimes, setTurnTimes] = useState<Record<string, number>>({})
  // The engine's own record of each turn. Present for live turns; empty for a
  // reloaded transcript, which is why the fold falls back to tool timings.
  const [turns, setTurns] = useState<TurnLedger>({})
  // Mirrored so the event handler folds against the latest ledger without
  // capturing a stale one for the length of a turn.
  const turnLedgerRef = useRef<TurnLedger>({})
  const [diffSource, setDiffSource] = useState<string>('working-tree')
  const [branchPatch, setBranchPatch] = useState('')
  const refreshGit = async () => {
    if (!cwd) return
    // One typed call replaces three ad-hoc `git` invocations. The engine owns
    // the porcelain parsing, so per-file stats and the staged/unstaged split
    // survive instead of being flattened into a dirty-file count.
    try {
      const st = await client.vcsStatus()
      setVcs(st)
      setGitBranch(st.refName)
      setGitDirty(st.staged.length + st.unstaged.length)
    } catch {}
    try {
      const patch = await client.getDiff()
      if (patch && !patch.includes('No uncommitted')) setDiffPatch(patch)
      else setDiffPatch('')
    } catch {}
    if (diffSource === 'branch') {
      try {
        const b = await client.bash(`git -C ${JSON.stringify(cwd)} diff --unified=3 main...HEAD`, () => {})
        setBranchPatch(b.output)
      } catch {
        try {
          const b2 = await client.bash(`git -C ${JSON.stringify(cwd)} diff HEAD`, () => {})
          setBranchPatch(b2.output)
        } catch {}
      }
    }
  }

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 })
  const [messages, setMessages] = useState<Message[]>([])
  const [activities, setActivities] = useState<ToolActivity[]>([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingInteraction | null>(null)
  const [answerDraft, setAnswerDraft] = useState('')
  const [loadingTranscript, setLoadingTranscript] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [overlay, setOverlay] = useState<'search' | 'add-project' | null>(null)
  // The path being typed into the add-project sheet, kept here rather than in
  // the sheet so the sheet can be reopened with the last attempt in it.
  const [projectPath, setProjectPath] = useState('')
  // What a relative path in the field is taken from, in the form a person would
  // type. It is the start directory, which defaults to the home folder, so the
  // field can be left showing "~/".
  const projectRootHint = (() => {
    const home = os.homedir()
    const base = startDir.trim()
    if (base === '' || base === home) return '~/'
    if (base.startsWith(home + '/')) return '~' + base.slice(home.length)
    return base
  })()
  const [projectPending, setProjectPending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diffOpen, setDiffOpen] = useState(false)
  const [diffPatch, setDiffPatch] = useState('')
  const searchInputRef = useRef<PublicInstance | null>(null)
  const projectInputRef = useRef<PublicInstance | null>(null)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [tailTick, setTailTick] = useState(0)
  // The clipboard is a side effect on shared system state, and neither GPUIX
  // nor the DOM exposes one, so the engine performs the write. The promise is
  // returned rather than swallowed: a stale engine rejects, and the control
  // needs to know so it can say so instead of claiming success.
  const copyText = useCallback(
    (text: string) => client.copyToClipboard(text),
    [client],
  )
  // What the agent is doing, for the live status row. Derived from events
  // rather than a separate protocol, so it cannot disagree with the transcript.
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ kind: 'idle' })
  // Tool names currently in flight. Kept outside the status so a status fold
  // does not have to thread a second value through every transition.
  const runningToolsRef = useRef<Set<string>>(new Set())
  // Mirrors agentStatus so the event handler folds against the latest value.
  // A ref rather than the state value, because the callback would otherwise
  // close over a stale status and drop transitions.
  const agentStatusRef = useRef<AgentStatus>({ kind: 'idle' })
  const [focusTick, setFocusTick] = useState(0)

  const listRef = useRef<PublicInstance | null>(null)
  const msgSeq = useRef(0)
  const { renderer } = useGpuix()
  // Published so the module-level clearTextSelection() helper can reach the
  // renderer from event handlers that sit outside this component.
  setModuleRenderer(renderer)
  const { ime } = useWindowInsets()

  const refreshSessions = async () => {
    try {
      const now = Date.now()
      const items = await client.listSessions()
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      setConversations(
        items.map((item) => ({
          id: item.path,
          title: item.name || 'Untitled session',
          group: groupForSession(item.updatedAt, now),
          project: projectName(item.cwd),
          time: relativeTime(item.updatedAt, now),
        })),
      )
    } catch {
      // The sidebar keeps its last known list; failures surface at the
      // point of action instead of blanking navigation.
    }
  }

  const refreshProviders = async () => {
    try {
      setProviders(await client.getProviders())
      setProviderError('')
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : String(e))
    }
  }

  const bootstrap = async () => {
    try {
      const [state, modelList, providerList, levels] = await Promise.all([
        client.getState(),
        client.getModels(),
        client.getProviders(),
        client.getThinkingLevels(),
      ])
      setModelState(state.model)
      setProviderState(state.provider)
      setReasoningState(state.thinkingLevel)
      setReasoningLevels(levels)
      setApprovalModeState(state.approvalMode === 'ask' ? 'ask' : 'auto')
      setFollowUpState(
        state.followUpMode === 'all' || state.steeringMode === 'all' ? 'steer' : 'queue',
      )
      setTextModelState(state.titleModel)
      setApiBaseURL(state.apiEndpointBaseURL)
      setStartDir(state.defaultProject)
      setModels(modelList)
      setProviders(providerList)
      setCwd(state.cwd)
      try {
        setProjects((await client.listProjects()).projects)
      } catch {
        setProjects([])
      }
      setEngineUp(true)
      setEngineError('')
      await refreshSessions()
    } catch (e) {
      setEngineUp(false)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  // t3code-style live git — branch + dirty count follow cwd, like the breadcrumb does
  useEffect(() => {
    void refreshGit()
    if (!settings.gitAutoFetch || !cwd) return
    const id = setInterval(() => void refreshGit(), 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, settings.gitAutoFetch])

  useEffect(() => {
    if (diffSource !== 'branch' || !cwd) return
    void (async () => {
      try {
        const b = await client.bash(`git -C ${JSON.stringify(cwd)} diff --unified=3 main...HEAD`, () => {})
        if (b.output.trim()) setBranchPatch(b.output)
        else {
          const b2 = await client.bash(`git -C ${JSON.stringify(cwd)} diff HEAD`, () => {})
          setBranchPatch(b2.output)
        }
      } catch {}
    })()
  }, [diffSource, cwd])

  const active = conversations.find((conversation) => conversation.id === activeId)
  const rows = useMemo(() => deriveTimelineRows(messages, activities, turnDiffs), [messages, activities, turnDiffs])
  /**
   * Whether the chat area has nothing to show, which is the only time the
   * project's recent sessions belong there instead of a transcript.
   *
   * Every clause is a real case rather than defensive padding. A Design Mode
   * run has no session id at all, and its verdict outlives the run, so keying
   * this on `activeId` alone put the verdict behind the session list for the
   * whole time it mattered. `busy` is deliberately absent: `send` sets the
   * session id the moment the engine returns it, which is before the turn is
   * awaited, so a turn in flight already has one.
   */
  const nothingOpen =
    activeId === null &&
    pending === null &&
    designPhases.length === 0 &&
    designOutcome === null
  const rowCount = rows.length
  const canGoBack = nav.index > 0
  const canGoForward = nav.index < nav.stack.length - 1
  const searchHits = query.trim()
    ? conversations.filter((conversation) =>
        conversation.title.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : conversations

  const loadSession = async (path: string) => {
    setLoadingTranscript(true)
    setActivities([])
    setPending(null)
    setMessages([])
    // Turn diffs are keyed by the live turn ids minted during streaming, which
    // do not exist in a reloaded transcript. Left in place they would either
    // attach to the wrong turn or linger for a session that never had them.
    setTurnDiffs({})
    setTurnTimes({})
    // The ledger records turns this client watched. A reloaded transcript was
    // streamed by some other process, so nothing here describes it.
    turnLedgerRef.current = {}
    setTurns({})
    try {
      const page = await client.getTranscriptPage('', TRANSCRIPT_PAGE, path)
      // Tool activity travels with the message, so a reloaded turn shows the
      // same folded tool rows a live turn did. Without this the calls were
      // printed inline as prose, which is what made `[tool] bash` show up in
      // the transcript body.
      //
      // A turn is one user prompt and everything the agent did in answer:
      // interleaved prose, tool calls, and their results. Stored pages carry no
      // turn id, so one is derived here — a new turn begins at each *user*
      // message and every assistant message after it joins that turn. Minting
      // one per tool-bearing message instead made each tool call its own turn,
      // so "Worked for…" appeared after every single call rather than once when
      // the agent stopped.
      let turnSeq = 0
      let currentTurn: string | undefined
      setMessages(
        page.messages.map((m) => {
          if (m.role === 'user') {
            currentTurn = `r${++turnSeq}`
            return { id: m.id, role: m.role, content: m.content, turnId: currentTurn }
          }
          const turnId = currentTurn ?? `r${++turnSeq}`
          currentTurn = turnId
          const tools = m.tools
          if (!tools || tools.length === 0) {
            return { id: m.id, role: m.role, content: m.content, turnId }
          }
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            turnId,
            tools: tools.map((t, i) => ({
              id: `${m.id}-tool-${i}`,
              name: t.name,
              status: t.status,
              turnId,
              // A stored page has no timestamps, so these stay unknown. The
              // duration label reads that as "not measured" rather than
              // inventing a zero-second turn.
              createdAt: undefined,
              endedAt: undefined,
              output: t.output,
              args: t.args,
            })),
          }
        }),
      )
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingTranscript(false)
    }
  }

  const selectSession = (path: string, push: boolean) => {
    setOverlay(null)
    if (path === activeId) {
      setFocusTick((value) => value + 1)
      return
    }
    setActiveId(path)
    if (push) {
      setNav((current) => ({
        stack: current.stack.slice(0, current.index + 1).concat(path),
        index: current.index + 1,
      }))
    }
    setFocusTick((value) => value + 1)
    void loadSession(path)
  }

  const goTo = (id: string) => selectSession(id, true)

  const goBack = () => {
    if (nav.index <= 0) return
    const index = nav.index - 1
    const path = nav.stack[index]!
    setActiveId(path)
    setNav({ ...nav, index })
    setFocusTick((value) => value + 1)
    void loadSession(path)
  }

  const goForward = () => {
    if (nav.index >= nav.stack.length - 1) return
    const index = nav.index + 1
    const path = nav.stack[index]!
    setActiveId(path)
    setNav({ ...nav, index })
    setFocusTick((value) => value + 1)
    void loadSession(path)
  }

  /**
   * Adds a project and refreshes the picker.
   *
   * The engine validates: the path must resolve to an existing directory, and
   * adding one already present is a no-op that reports added=false rather than
   * an error. The two failures worth distinguishing are a path that does not
   * exist and one that is a file, and the engine's message says which, so it
   * is shown rather than replaced with something generic.
   */
  /**
   * Asks the engine for the directories that match what was typed.
   *
   * This is the qq3 shape: a walk under the projects root, fuzzy-matched
   * against the query, best first. An empty query is not "no results" — it is
   * the unfiltered list, which is what a fuzzy finder shows the moment it
   * opens and what makes typing a filter rather than a path. The engine ranks;
   * the field only supplies the query.
   */
  /**
   * The dialog's arrow keys, parked on the window for as long as it is open.
   *
   * Up and down wrap, so holding a key walks the list rather than sticking at
   * the end. Enter takes the highlighted row, which is what qq3 does and the
   * reason the row has to be visible at all.
   */
  /**
   * Adds the project named in the field and switches to it.
   *
   * The field holds what a person typed, which may be relative or start with a
   * tilde, so the switch uses the path the engine resolved rather than the text
   * that was typed. Switching to the raw text would move to a directory that
   * does not exist.
   */
  const addProject = async (raw: string) => {
    const typed = raw.trim()
    if (!typed) return
    try {
      const result = await client.addProject(typed)
      const path = result.project.path
      setProjectPath('')
      setOverlay(null)
      setProjects((await client.listProjects()).projects)
      // Adding lands you in the project, and the sidebar chip is driven by cwd,
      // so the chip changes in the same place the choice was made. That is the
      // receipt, and it is why a success says nothing.
      //
      // It used to write "Added foo." into submitNotice — a 12px line above the
      // composer that exists to report refusals, engine down or empty prompt.
      // Routing the one piece of good news through a channel built for problems
      // made it the least visible thing on screen.
      await switchProject(path)
      // The duplicate still speaks. Here the visible outcome is identical to a
      // successful add — you end up in the project either way — and only the
      // engine knows nothing was written, so the line is the only thing that
      // can say so.
      if (!result.added) {
        setSubmitNotice(`${projectName(result.project.path)} is already a project.`)
      }
    } catch (e) {
      setSubmitNotice(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Sets the directory a session opens in. The engine owns the decision and
   * switches to it, so the value on screen is the one in force rather than a
   * value the app hopes will be read next time.
   */
  const saveStartDir = async (next: string) => {
    setStartDirError('')
    try {
      const result = await client.setDefaultProject(next.trim())
      setStartDir(result.defaultProject)
      if (result.cwd) setCwd(result.cwd)
      await refreshSessions()
    } catch (e) {
      setStartDirError(e instanceof Error ? e.message : String(e))
    }
  }

  const newTask = () => {
    setActiveId(null)
    setMessages([])
    setActivities([])
    setPending(null)
    setDraft('')
    setFocusTick((value) => value + 1)
  }

  /**
   * Pins the working tree to a turn as its changes card.
   *
   * First writer wins. A turn that errors can reach both this and the error
   * path, and the second snapshot is taken after further edits have landed, so
   * overwriting would attribute the wrong diff to the turn.
   */
  const captureTurnDiff = async (turn: string) => {
    try {
      const patch = await client.getDiff()
      if (!patch || !patch.trim() || patch.includes('No uncommitted')) return
      let stored = false
      setTurnDiffs((prev) => {
        if (prev[turn]) return prev
        stored = true
        return { ...prev, [turn]: patch }
      })
      if (stored) {
        setTurnTimes((prev) => (prev[turn] ? prev : { ...prev, [turn]: Date.now() }))
        setDiffPatch(patch)
      }
    } catch {
      // A failed snapshot is not worth surfacing: the turn itself succeeded,
      // and the Source Control panel still shows the live working tree.
    }
  }

  const send = async (text: string): Promise<SubmitResult> => {
    const trimmed = text.trim()
    const refusal = validatePrompt(trimmed, { busy, engineUp })
    if (refusal) {
      setSubmitNotice(refusal)
      return { didDispatch: false, validationMessage: refusal }
    }
    if (!trimmed) return { didDispatch: false, validationMessage: null }
    setSubmitNotice('')
    let path = activeId
    let turnId: string | undefined = undefined
    // Declared out here so the flush callback can close over it, and so the
    // catch path can still flush: an error mid-turn must not truncate the
    // answer.
    let assistantId = ''
    setDraft('')
    setBusy(true)
    setPending(null)
    const stream = createBlockStreamer((chunk) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId ? { ...message, content: message.content + chunk } : message,
        ),
      )
      // Follow the answer as it arrives. Without this the transcript stays
      // parked at whatever row the turn started on, so a long answer streams
      // in below the fold and the user watches nothing happen.
      setTailTick((value) => value + 1)
    })
    try {
      if (!path) {
        const created = await client.newSession()
        if (!created) throw new Error('The engine did not create a session.')
        path = created.path
        setActiveId(path)
        setNav((current) => ({
          stack: current.stack.slice(0, current.index + 1).concat(path!),
          index: current.index + 1,
        }))
      }
      const n = ++msgSeq.current
      // A provisional id, so the optimistic rows have somewhere to sit before
      // the engine has answered. It is replaced by the engine's own turn id
      // the moment `turn_start` names one.
      turnId = `t${Date.now()}-${n}`
      const userId = `u-${turnId}`
      assistantId = `a-${turnId}`
      const now = Date.now()
      setMessages((current) => [
        ...current,
        { id: userId, role: 'user', content: trimmed, turnId, createdAt: now },
        { id: assistantId, role: 'assistant', content: '', turnId, createdAt: now },
      ])
      setTailTick((value) => value + 1)

      // Deltas are buffered by `stream` above and released a block at a time.
      await client.send(trimmed, [], (event: AgentEvent) => {
        // The engine owns turn boundaries. Recording its account — and only
        // writing state when it actually says something — is what keeps the
        // fold, the duration, and the changes card keyed to one real turn
        // instead of a guess made from message order.
        const folded = applyTurnEvent(turnLedgerRef.current, event, Date.now())
        if (folded.changed) {
          turnLedgerRef.current = folded.ledger
          setTurns(folded.ledger)
        }
        if (event.kind === 'turn_start' && event.turnId && turnId && event.turnId !== turnId) {
          // Adopt the engine's id for this turn. The optimistic rows were
          // filed under the provisional one, so they move with it — otherwise
          // the turn's tools, diff, and prose end up under different keys and
          // the fold renders empty.
          const provisional = turnId
          turnId = event.turnId
          setMessages((current) =>
            current.map((message) =>
              message.turnId === provisional ? { ...message, turnId: event.turnId! } : message,
            ),
          )
          setActivities((current) =>
            current.map((activity) =>
              activity.turnId === provisional ? { ...activity, turnId: event.turnId! } : activity,
            ),
          )
        }
        // Every event folds into the status row, so the indicator can never
        // claim something the transcript does not show.
        const next = reduceAgentStatus(agentStatusRef.current, runningToolsRef.current, event)
        agentStatusRef.current = next.status
        runningToolsRef.current = next.running
        setAgentStatus(next.status)

        if (event.kind === 'text_delta') {
          stream.push(event.text)
        } else if (event.kind === 'tool_start') {
          setActivities((current) => [
            ...current,
            {
              id: event.toolCallId,
              name: event.toolName,
              status: 'running',
              turnId,
              createdAt: Date.now(),
            },
          ])
        } else if (event.kind === 'tool_end') {
          setActivities((current) =>
            current.map((activity) =>
              activity.id === event.toolCallId
                ? { ...activity, status: event.isError ? 'error' : 'done', endedAt: Date.now() }
                : activity,
            ),
          )
        } else if (event.kind === 'turn_end') {
          // The engine says the turn is over, so this is the one moment the
          // working tree still describes this turn and nothing after it. The
          // snapshot used to run only on the error path, which meant a turn
          // that succeeded after editing files never got a changes card.
          const closing = turnId
          if (closing) {
            void captureTurnDiff(closing)
          }
        } else if (event.kind === 'approval') {
          setPending({ kind: 'approval', toolCallId: event.toolCallId, toolName: event.toolName })
        } else if (event.kind === 'question') {
          setPending({ kind: 'question', questionId: event.questionId, question: event.question })
        } else if (event.kind === 'error') {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: `${message.content}\n\nError: ${event.message}` }
                : message,
            ),
          )
        } else if (event.kind === 'session_switched') {
          const switched = event.path
          setActiveId(switched)
          setNav((current) => ({
            stack: current.stack.slice(0, current.index + 1).concat(switched),
            index: current.index + 1,
          }))
          void loadSession(switched)
        }
      })
      // The turn has settled, so anything still buffered is the final
      // paragraph. Without this the tail of every answer would be lost.
      stream.flush()
    } catch (e) {
      // An error mid-turn still leaves buffered text unwritten; release it so
      // the partial answer is not silently truncated.
      stream.flush()
      setMessages((current) => [
        ...current,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${e instanceof Error ? e.message : String(e)}`,
        },
      ])
      // A turn that died before it could report turn_end still owes a snapshot.
      // captureTurnDiff is first-writer-wins, so this cannot race the one the
      // turn_end handler already took.
      if (turnId) await captureTurnDiff(turnId)
    } finally {
      setBusy(false)
      setPending(null)
      setTailTick((value) => value + 1)
      void refreshSessions()
      void refreshGit()
    }
    // The prompt was accepted and a turn was opened. Failures surface as an
    // error row above; the submit itself did happen.
    return { didDispatch: true, validationMessage: null }
  }

  /**
   * Starts a Design Mode run.
   *
   * This is the composer's own route to a design run. It is not `send` with a
   * flag: a design run is not a turn, it cannot be steered, and its phases
   * arrive as events over minutes. Forwarding it to the engine's /design
   * command would mean rendering its terminal output as if it were the
   * transcript, which is the thing this route exists to avoid.
   */
  const startDesign = async (text: string) => {
    const trimmed = text.trim()
    const refusal = validatePrompt(trimmed, { busy: designBusy, engineUp })
    if (refusal) {
      setSubmitNotice(refusal)
      return
    }
    if (!trimmed) return
    setSubmitNotice('')
    setDraft('')
    setDesignPhases([])
    setDesignOutcome(null)
    setDesignBusy(true)
    setTailTick((v) => v + 1)
    try {
      await client.startDesign(trimmed, (event: AgentEvent) => {
        if (event.kind === 'design_progress') {
          setDesignPhases((current) => [...current, {
            phase: event.phase,
            pass: event.pass,
            detail: event.detail,
          }])
          setTailTick((v) => v + 1)
        } else if (event.kind === 'design_done') {
          setDesignOutcome({
            passed: event.passed,
            repairs: event.repairs,
            verdict: event.verdict,
            why: event.why,
            shots: event.shots,
            error: event.error,
          })
        }
      })
    } catch (e) {
      setDesignOutcome({
        passed: false, repairs: 0, verdict: '', why: '', shots: [],
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setDesignBusy(false)
      setTailTick((v) => v + 1)
    }
  }

  /** Design mode replaces the turn's send with its own. */
  const submit = (text: string) => (designOn ? void startDesign(text) : void send(text))

  const stop = () => {
    try {
      client.stop()
    } catch {
      setBusy(false)
    }
  }

  const answerApproval = async (approved: boolean) => {
    const current = pending
    setPending(null)
    if (current?.kind !== 'approval') return
    try {
      await client.answerApproval(current.toolCallId, approved)
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const answerQuestion = async (text: string) => {
    const current = pending
    if (current?.kind !== 'question' || text.trim() === '') return
    setPending(null)
    setAnswerDraft('')
    try {
      await client.answerQuestion(current.questionId, text.trim())
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const changeModel = async (next: string) => {
    const prev = model
    setModelState(next)
    try {
      await client.setModel(next)
    } catch (e) {
      setModelState(prev)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const changeReasoning = async (next: string) => {
    const prev = reasoning
    setReasoningState(next)
    try {
      await client.setThinkingLevel(next)
    } catch (e) {
      setReasoningState(prev)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const changeApprovalMode = async (next: string) => {
    const prev = approvalMode
    const mode = next === 'ask' ? 'ask' : 'auto'
    setApprovalModeState(mode)
    try {
      await client.setApprovalMode(mode)
    } catch (e) {
      setApprovalModeState(prev)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const changeFollowUp = async (next: 'queue' | 'steer') => {
    const prev = followUp
    const engineMode = next === 'steer' ? 'all' : 'one-at-a-time'
    setFollowUpState(next)
    try {
      await client.setSteeringMode(engineMode)
      await client.setFollowUpMode(engineMode)
    } catch (e) {
      setFollowUpState(prev)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const changeTextModel = async (next: string) => {
    const prev = textModel
    setTextModelState(next)
    try {
      await client.setTitleModel(next)
    } catch (e) {
      setTextModelState(prev)
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  const changeProvider = async (next: string) => {
    const prev = provider
    setProviderState(next)
    try {
      await client.setProvider(next)
      await refreshProviders()
    } catch (e) {
      setProviderState(prev)
      setProviderError(e instanceof Error ? e.message : String(e))
    }
  }

  const saveProviderKey = async (id: 'opencode-go' | 'opencode-zen', key: string) => {
    try {
      await client.setApiKey(id, key)
      await refreshProviders()
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeProviderKey = async (id: 'opencode-go' | 'opencode-zen' | 'api') => {
    try {
      await client.removeApiKey(id)
      await refreshProviders()
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : String(e))
    }
  }

  const saveEndpoint = async (baseURL: string, key: string) => {
    try {
      await client.setApiEndpoint(baseURL, key)
      await refreshProviders()
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : String(e))
    }
  }

  const switchProject = async (path: string) => {
    try {
      const result = await client.switchProject(path)
      setCwd(result.cwd)
      // The engine records the use and reorders the list, so the sidebar has to
      // ask again. Keeping the first list meant the project you just switched
      // to never moved, which is the one moment the order is meant to change.
      setProjects((await client.listProjects()).projects)
      await refreshSessions()
    } catch (e) {
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * Clicking a project in the sidebar.
   *
   * Clicking the project you are already in returns to its session list rather
   * than doing nothing. Without that, the list is reachable only before the
   * first session is opened, and there is no way back to it — the sidebar row
   * would be a one-way door.
   */
  const openProject = async (path: string) => {
    if (path === cwd) {
      setActiveId(null)
      return
    }
    await switchProject(path)
  }

  const openDiff = async () => {
    setDiffOpen(true)
    try {
      setDiffPatch(await client.getDiff())
    } catch (e) {
      setDiffPatch('')
      setEngineError(e instanceof Error ? e.message : String(e))
    }
  }

  // The transcript follows the tail on its own (followTail on the list), so
  // this only handles the case where the user is parked at the bottom when a
  // new turn starts: then the newest row needs an explicit jump.
  useEffect(() => {
    if (tailTick === 0) return
    const id = listRef.current?.id
    if (id == null || !renderer?.scrollToItem) return
    renderer.scrollToItem(id, Math.max(0, rowCount - 1))
  }, [renderer, rowCount, tailTick])

  // The list reports which rows it has built. Reaching the last one means the
  // user is at the bottom, so a fresh turn should pull them to the tail.
  return (
    <div
      testId="app-root"
      style={{
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
        height: '100%',
        backgroundColor: C.canvas,
        fontFamily: FONT_SANS,
        color: C.text,
        position: 'relative',
      }}
    >
      {settingsOpen ? (
        <SettingsScreen
          settings={settings}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          models={models}
          providers={providers}
          defaultProvider={provider}
          onDefaultProvider={changeProvider}
          apiBaseURL={apiBaseURL}
          providerError={providerError}
          onRefreshProviders={() => void refreshProviders()}
          onSaveKey={(id, key) => void saveProviderKey(id, key)}
          onRemoveKey={(id) => void removeProviderKey(id)}
          onSaveEndpoint={(baseURL, key) => void saveEndpoint(baseURL, key)}
          startDir={startDir}
          onStartDir={(next) => void saveStartDir(next)}
          startDirError={startDirError}
          followUp={followUp}
          onFollowUp={(next) => void changeFollowUp(next)}
          textModel={textModel}
          onTextModel={(next) => void changeTextModel(next)}
          sansOptions={sansOptions}
          monoOptions={monoOptions}
          gitBranch={gitBranch}
          gitDirty={gitDirty}
          onRefreshGit={() => void refreshGit()}
          onOpenDiff={() => void openDiff()}
        />
      ) : (
      <>
      <motion.div
        initial={false}
        animate={{ width: collapsed ? 0 : SIDEBAR_WIDTH + 1 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        style={{
          display: 'flex',
          flexDirection: 'row',
          height: '100%',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <Sidebar
          projects={projects}
          currentProject={cwd}
          onSelectProject={(path) => void openProject(path)}
          onCollapse={() => setCollapsed(true)}
          onNewTask={newTask}
          onAddProject={() => {
            setSubmitNotice('')
            // The field opens showing the start directory, so "Projects/escape"
            // is a path from there rather than something to retype in full.
            setProjectPath(projectRootHint)
            setOverlay('add-project')
          }}
          onSearch={() => {
            setQuery('')
            setOverlay('search')
          }}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={goBack}
          onForward={goForward}
          onSettings={() => setSettingsOpen(true)}
        />
        <div style={{ width: 1, height: '100%', flexShrink: 0, backgroundColor: C.sidebarBorder }} />
      </motion.div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flexGrow: 1,
          minWidth: 0,
          height: '100%',
          paddingBottom: ime.bottom,
          backgroundColor: C.canvas,
        }}
      >
        <Header
          collapsed={collapsed}
          onExpand={() => setCollapsed(false)}
          title={active?.title ?? 'New task'}
          gitBranch={gitBranch}
          gitDirty={gitDirty}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onBack={goBack}
          onForward={goForward}
          onToggleDiff={() => void openDiff()}
          onToggleGit={() => {
            setGitSidebarOpen(v => {
              // Opening the panel re-reads the tree: a turn may have just
              // written to it, and a stale staged/unstaged list is worse than
              // no list.
              if (!v) void refreshGit()
              return !v
            })
          }}
        />
        {nothingOpen ? (
          <RecentSessions
            conversations={conversations}
            project={cwd}
            onSelect={(id) => void goTo(id)}
          />
        ) : (
        <Transcript
          key={activeId}
          rows={rows}
          listRef={listRef}
          onCopy={copyText}
          status={agentStatus}
          turns={turns}
          designPhases={designPhases}
          designOutcome={designOutcome}
          onOpenDiff={() => {
            setGitSidebarOpen(true)
            void refreshGit()
          }}
        />
        )}
        {pending && (
          <PendingCard
            pending={pending}
            answer={answerDraft}
            onApprove={(approved) => void answerApproval(approved)}
            onAnswer={(text) => void answerQuestion(text)}
            onDismiss={(text) => setAnswerDraft(text)}
          />
        )}
        {submitNotice !== '' && (
          <div
            testId="submit-notice"
            role="status"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flexShrink: 0,
              paddingLeft: 20,
              paddingRight: 20,
              paddingTop: 6,
            }}
          >
            <text style={{ fontSize: 12, color: C.tertiary }}>{submitNotice}</text>
          </div>
        )}
        {engineError !== '' && (
          <div
            testId="engine-error"
            role="alert"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              flexShrink: 0,
              paddingLeft: 20,
              paddingRight: 20,
              paddingBottom: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                maxWidth: CONTENT_MAX_WIDTH,
                backgroundColor: C.raised,
                borderWidth: 1,
                borderColor: C.error,
                borderRadius: 10,
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 12,
                paddingRight: 8,
              }}
            >
              <text
                style={{
                  flexGrow: 1,
                  minWidth: 0,
                  fontSize: 13,
                  lineHeight: 18,
                  fontFamily: FONT_SANS,
                  color: C.secondary,
                }}
              >
                {engineError}
              </text>
              <Button
                testId="engine-retry"
                aria-label="Retry engine connection"
                onClick={() => void bootstrap()}
                style={{
                  height: 28,
                  flexShrink: 0,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 7,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  backgroundColor: C.overlay,
                  hover: { backgroundColor: C.overlayStrong },
                }}
              >
                <text style={{ fontSize: 12.5, color: C.text }}>Retry</text>
              </Button>
            </div>
          </div>
        )}
        <Composer
          value={draft}
          onChange={(next) => {
            setDraft(next)
            // A notice about the previous attempt stops being true the moment
            // the prompt changes.
            if (submitNotice !== '') setSubmitNotice('')
          }}
          focusTick={focusTick}
          onSend={(text) => submit(text)}
          model={model}
          models={models}
          onModelChange={(next) => void changeModel(next)}
          reasoning={reasoning}
          reasoningLevels={reasoningLevels}
          onReasoningChange={(next) => void changeReasoning(next)}
          approvalMode={approvalMode}
          onApprovalModeChange={(next) => void changeApprovalMode(next)}
          busy={busy}
          onStop={designOn && designBusy ? () => void client.cancelDesign() : stop}
          engineUp={engineUp}
          designOn={designOn}
          designBusy={designBusy}
          onToggleDesign={() => {
            if (designBusy) return
            setDesignOn((v) => !v)
            setDesignPhases([])
            setDesignOutcome(null)
          }}
        />
        <WorkspaceFooter connected={engineUp} />
      </div>
      {gitSidebarOpen && (
        <GitSidebar
          branch={gitBranch}
          dirty={gitDirty}
          patch={diffPatch}
          branchPatch={branchPatch}
          turnDiffs={turnDiffs}
          turnTimes={turnTimes}
          diffSource={diffSource}
          onDiffSourceChange={setDiffSource}
          onRefresh={() => void refreshGit()}
          onClose={() => setGitSidebarOpen(false)}
          layout={settings.diffLayout}
          onLayoutChange={(next) => updateSettings({ diffLayout: next })}
          onOpenFullDiff={() => void openDiff()}
          vcs={vcs}
          vcsError={vcsError}
          onStage={(paths) => { void runVcs(() => client.vcsStage(paths)) }}
          onUnstage={(paths) => { void runVcs(() => client.vcsUnstage(paths)) }}
          onCommit={(message, paths) => { void runVcs(() => client.vcsCommit(message, paths)) }}
          onFileDiff={path => client.vcsFileDiff(path)}
        />
      )}
      <OverlayCard
        title="Search threads"
        height={420}
        open={overlay === 'search'}
        onClose={() => setOverlay(null)}
        initialFocus={searchInputRef}
      >
        <input
          ref={searchInputRef}
          testId="search-input"
          value={query}
          placeholder="Filter by title"
          theme={currentTheme()}
          style={{
            width: '100%',
            height: 32,
            flexShrink: 0,
            fontSize: 13,
            color: C.text,
            backgroundColor: C.composer,
            borderRadius: 8,
            paddingLeft: 10,
            paddingRight: 10,
          }}
          onChange={(event) => setQuery(event.value ?? '')}
        />
        <div style={{ flexGrow: 1, minHeight: 0, overflowY: 'scroll' }}>
          {searchHits.map((conversation) => (
            <Button
              key={conversation.id}
              testId={`search-${conversation.id}`}
              onClick={() => goTo(conversation.id)}
              style={{
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 8,
                cursor: 'pointer',
                hover: { backgroundColor: C.overlay },
              }}
            >
              <text style={{ fontSize: 13, color: C.text }}>{conversation.title}</text>
            </Button>
          ))}
        </div>
      </OverlayCard>
      <DiffOverlay
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        patch={diffPatch}
        defaultCollapsed={settings.diffFileState === 'collapsed'}
        layout={settings.diffLayout}
        onLayoutChange={(next) => updateSettings({ diffLayout: next })}
      />

      <OverlayCard
        title="Add project"
        open={overlay === 'add-project'}
        onClose={() => setOverlay(null)}
        width={620}
        bare
        initialFocus={projectInputRef}
      >
        {/* A field, not a finder. The search that used to be here walked the
            tree and ranked directories against what was typed, which meant the
            answer to "which directory" was a list nobody had asked for. A
            person opening this knows the path, and the two forms they write are
            "~/Projects/escape" and "Projects/escape"; the engine expands the
            first and takes the second from the start directory. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            paddingLeft: 16,
            paddingRight: 16,
            paddingTop: 4,
            paddingBottom: 12,
          }}
        >
          <input
            ref={projectInputRef}
            testId="project-path-input"
            value={projectPath}
            placeholder={projectRootHint}
            theme={currentTheme()}
            onChange={(event) => setProjectPath(event.value ?? '')}
            onSubmit={() => void addProject(projectPath)}
            style={{
              height: 34,
              fontSize: 14,
              color: C.text,
              backgroundColor: '#00000000',
              borderWidth: 0,
            }}
          />
          <text
            testId="project-path-hint"
            style={{ fontSize: 11, color: C.muted, paddingTop: 6 }}
          >
            {projectRootHint === '~/' ? 'Relative to your home folder.' : `Relative to ${projectRootHint}.`}
            {'  '}
            Absolute paths work too.
          </text>
          <div style={{ height: 10 }} />
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              height: 24,
            }}
          >
            <div style={{ flexGrow: 1 }} />
            <text style={{ fontSize: 11, color: C.muted }}>↵ add</text>
            <div style={{ width: 12 }} />
            <text style={{ fontSize: 11, color: C.muted }}>esc close</text>
          </div>
        </div>
      </OverlayCard>
      </>
      )}
    </div>
  )
}

const isEntryPoint =
  typeof Bun !== 'undefined'
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof process !== 'undefined' && process.argv[1]?.endsWith('chat.tsx')

if (isEntryPoint) {
  applyMacCpuThrottleFromEnv()
  render(<ChatApp />, {
    title: 'GPUIX Chat',
    width: 1180,
    height: 820,
    titlebarTransparent: true,
    windowBackground: 'blurred',
    trafficLightX: 16,
    trafficLightY: 17,
    // debugFrameOverlay removed — was painting CUR / MAX / FRAMES stats top-right
    // An agent launching this to check its own work must not take the keyboard
    // away from whoever is typing. Automation needs no focus.
    focus: process.env.GPUIX_BACKGROUND !== '1',
    // The one place window keys can be observed. An input's own onKeyDown never
    // fires, so anything driven by arrow keys has to come through here.
    // RenderOptions extends WindowKeyEventHandlers, whose field is onKeyDown.
    // Supplying it is also what turns window key events on at all.
    onKeyDown: dispatchWindowKey,
  })
}
