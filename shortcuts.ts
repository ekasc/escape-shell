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
  | 'add-project'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'collapse-sidebar'
  | 'expand-sidebar'
  | 'close-top'
  | 'stop-agent'
  | 'toggle-inspector'
  | 'settings-section-session'
  | 'settings-section-model'
  | 'settings-section-memory'
  | 'settings-section-skills'
  | 'settings-section-approvals'
  | 'settings-section-account'
  | 'settings-section-diagnostics'

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
  { command: 'add-project', keys: 'Cmd+P', label: 'Add project' },
  { command: 'open-settings', keys: 'Cmd+,', label: 'Settings' },
  { command: 'toggle-sidebar', keys: 'Cmd+Ctrl+S', label: 'Toggle sidebar' },
  { command: 'collapse-sidebar', keys: 'Cmd+[', label: 'Collapse sidebar' },
  { command: 'expand-sidebar', keys: 'Cmd+]', label: 'Expand sidebar' },
  { command: 'close-top', keys: 'Cmd+W', label: 'Close settings' },
  { command: 'stop-agent', keys: 'Esc', label: 'Stop the running agent' },
  // The element picker, on the combination Chrome and every other toolkit uses
  // for the same thing. Outlines whatever is under the pointer and pins it on
  // click, so a layout question is answered by looking rather than by grepping.
  { command: 'toggle-inspector', keys: 'Alt+Cmd+I', label: 'Toggle the element picker' },
  // Named by section id, not by position. These used to be
  // `settings-section-1`…`-7`, resolved as `SETTINGS_SECTIONS[index - 1]`, so
  // the label in this table and the section that actually opened drifted apart
  // the moment the rail grew: `Cmd+4` opened Skills while claiming "Approvals
  // and queue", and three sections had no shortcut at all. A name that carries
  // its own target cannot rot when the rail is reordered.
  { command: 'settings-section-session', keys: 'Cmd+1', label: 'Settings: Session' },
  { command: 'settings-section-model', keys: 'Cmd+2', label: 'Settings: Model' },
  { command: 'settings-section-memory', keys: 'Cmd+3', label: 'Settings: Memory' },
  { command: 'settings-section-skills', keys: 'Cmd+4', label: 'Settings: Skills' },
  { command: 'settings-section-approvals', keys: 'Cmd+5', label: 'Settings: Approvals and queue' },
  { command: 'settings-section-account', keys: 'Cmd+6', label: 'Settings: Account' },
  { command: 'settings-section-diagnostics', keys: 'Cmd+7', label: 'Settings: Diagnostics' },
]

/**
 * Cmd+F was the command palette's alias and went with it. Cmd+, stays because
 * the HIG fixes that combination for Settings.
 */
const ALIASES: Record<string, WindowCommand> = {
  ',': 'open-settings',
  // Cmd+P is taken by print in most Mac apps and means nothing here, which is
  // what makes it a reasonable "open the project finder" binding.
  p: 'add-project',
}

const DIGIT_SECTIONS: Record<string, WindowCommand> = {
  '1': 'settings-section-session',
  '2': 'settings-section-model',
  '3': 'settings-section-memory',
  '4': 'settings-section-skills',
  '5': 'settings-section-approvals',
  '6': 'settings-section-account',
  '7': 'settings-section-diagnostics',
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
  // Alt+Cmd+I has to be matched here, above the catch-all below, because that
  // line rejects every combination carrying Alt. Left in the plain switch it
  // would never be reached, and the binding would silently do nothing — which
  // is the whole failure mode a shortcut table exists to prevent.
  if (modifiers.alt && !modifiers.ctrl && !modifiers.shift && key === 'i') return 'toggle-inspector'
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
