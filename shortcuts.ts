/**
 * Window-level keyboard commands.
 *
 * GPUIX has no native menu bar (Rule 1 of the macOS HIG is not implementable
 * here), so the menu bar's discovery role has to be served by the keyboard plus
 * the command palette. This module is deliberately a pure matcher: it maps a
 * key event to a command name and back to a human-readable shortcut, so the
 * table and the behaviour cannot drift apart and both are testable without a
 * GPU renderer.
 */

export type WindowCommand =
  | 'new-chat'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'collapse-sidebar'
  | 'expand-sidebar'
  | 'close-top'
  | 'stop-agent'
  | 'settings-section-1'
  | 'settings-section-2'
  | 'settings-section-3'
  | 'settings-section-4'
  | 'settings-section-5'
  | 'settings-section-6'
  | 'settings-section-7'

/** The shape of the key payload Escape cares about. */
export type KeyEventLike = {
  key?: string
  modifiers?: { cmd?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }
}

/**
 * The shortcut table. Order is display order: this is the reference the help
 * text and the command palette read from, so a shortcut is documented in exactly
 * one place.
 */
export const SHORTCUTS: ReadonlyArray<{ command: WindowCommand; keys: string; label: string }> = [
  { command: 'new-chat', keys: 'Cmd+N', label: 'New chat' },
  { command: 'open-settings', keys: 'Cmd+,', label: 'Settings' },
  { command: 'toggle-sidebar', keys: 'Cmd+Ctrl+S', label: 'Toggle sidebar' },
  { command: 'collapse-sidebar', keys: 'Cmd+[', label: 'Collapse sidebar' },
  { command: 'expand-sidebar', keys: 'Cmd+]', label: 'Expand sidebar' },
  { command: 'close-top', keys: 'Cmd+W', label: 'Close settings' },
  { command: 'stop-agent', keys: 'Esc', label: 'Stop the running agent' },
  { command: 'settings-section-1', keys: 'Cmd+1', label: 'Settings: Session' },
  { command: 'settings-section-2', keys: 'Cmd+2', label: 'Settings: Model' },
  { command: 'settings-section-3', keys: 'Cmd+3', label: 'Settings: Memory' },
  { command: 'settings-section-4', keys: 'Cmd+4', label: 'Settings: Approvals and queue' },
  { command: 'settings-section-5', keys: 'Cmd+5', label: 'Settings: Account' },
  { command: 'settings-section-6', keys: 'Cmd+6', label: 'Settings: Diagnostics' },
  { command: 'settings-section-7', keys: 'Cmd+7', label: 'Settings: Developer tools' },
]

/**
 * Cmd+F was the command palette's alias and went with it. Cmd+, stays because
 * the HIG fixes that combination for Settings.
 */
const ALIASES: Record<string, WindowCommand> = {
  ',': 'open-settings',
}

const DIGIT_SECTIONS: Record<string, WindowCommand> = {
  '1': 'settings-section-1',
  '2': 'settings-section-2',
  '3': 'settings-section-3',
  '4': 'settings-section-4',
  '5': 'settings-section-5',
  '6': 'settings-section-6',
  '7': 'settings-section-7',
}

/**
 * matchCommand resolves a key event to a command, or null to let the event
 * through. Escape is always consumed: on Mac it must cancel or close, never
 * fall through to whatever the focused control would do with it.
 */
export function matchCommand(event: KeyEventLike): WindowCommand | null {
  if (event.key === 'escape') return 'stop-agent'

  const modifiers = event.modifiers
  if (!modifiers?.cmd) return null
  const key = (event.key ?? '').toLowerCase()
  if (!key) return null

  // Modifier combos are checked before the plain ones so Cmd+Ctrl+S is not
  // read as Cmd+S.
  if (modifiers.ctrl && !modifiers.shift && !modifiers.alt && key === 's') return 'toggle-sidebar'
  if (modifiers.shift && !modifiers.ctrl && !modifiers.alt) return null
  if (modifiers.ctrl || modifiers.alt || modifiers.shift) return null

  if (DIGIT_SECTIONS[key]) return DIGIT_SECTIONS[key]

  switch (key) {
    case 'n': return 'new-chat'
    case 'w': return 'close-top'
    case '[': return 'collapse-sidebar'
    case ']': return 'expand-sidebar'
    default: {
      const alias = ALIASES[key]
      return alias ?? null
    }
  }
}
