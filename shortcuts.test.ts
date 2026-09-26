import { describe, expect, it } from 'vitest'

import { matchCommand, SHORTCUTS } from './shortcuts'

const cmd = (key: string, modifiers: Record<string, boolean> = {}) =>
  matchCommand({ key, modifiers: { cmd: true, ...modifiers } })

describe('window shortcuts', () => {
  it('maps the standard macOS combinations', () => {
    expect(cmd('n')).toBe('new-chat')
    expect(cmd(',')).toBe('open-settings')
    expect(cmd('w')).toBe('close-top')
    expect(cmd('[')).toBe('collapse-sidebar')
    expect(cmd(']')).toBe('expand-sidebar')
  })

  it('reads Cmd+Ctrl+S as the sidebar toggle, not Cmd+S', () => {
    // The modifier check has to run first or this collides with a Cmd+S.
    expect(cmd('s', { ctrl: true })).toBe('toggle-sidebar')
    expect(cmd('s')).toBeNull()
  })

  it('no longer claims the keys the command palette used', () => {
    // The palette is gone, so its shortcuts must not fire a stale command.
    expect(cmd('k')).toBeNull()
    expect(cmd('k', { shift: true })).toBeNull()
    expect(cmd('f')).toBeNull()
  })

  it('maps Cmd+1 through Cmd+7 onto settings sections', () => {
    expect(cmd('1')).toBe('settings-section-1')
    expect(cmd('3')).toBe('settings-section-3')
    expect(cmd('7')).toBe('settings-section-7')
    expect(cmd('8')).toBeNull()
  })

  it('treats Escape as a command even with no modifiers', () => {
    expect(matchCommand({ key: 'escape' })).toBe('stop-agent')
  })

  it('ignores events without Cmd so text editing is untouched', () => {
    expect(matchCommand({ key: 'k' })).toBeNull()
    expect(matchCommand({ key: 'n' })).toBeNull()
    expect(matchCommand({ key: 'k', modifiers: { cmd: false, ctrl: true } })).toBeNull()
  })

  it('never claims clipboard and undo combinations', () => {
    // These belong to native text handling; hijacking them would break selection.
    for (const key of ['c', 'v', 'x', 'z', 'a', 'k', 'f']) {
      expect(cmd(key)).toBeNull()
      expect(cmd(key, { shift: true })).toBeNull()
    }
  })

  it('ignores an empty key', () => {
    expect(cmd('')).toBeNull()
    expect(matchCommand({ modifiers: { cmd: true } })).toBeNull()
  })

  it('documents every command exactly once in the reference table', () => {
    const commands = SHORTCUTS.map((shortcut) => shortcut.command)
    expect(new Set(commands).size).toBe(commands.length)
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.label.length).toBeGreaterThan(0)
      expect(shortcut.keys).toMatch(/^(Cmd|Esc)/)
    }
  })

  it('gives every table entry a shortcut that actually resolves', () => {
    // The palette prints this table, so a row that cannot fire is a lie.
    for (const shortcut of SHORTCUTS) {
      if (shortcut.keys === 'Esc') {
        expect(matchCommand({ key: 'escape' })).toBe(shortcut.command)
        continue
      }
      const parts = shortcut.keys.split('+')
      const key = parts[parts.length - 1].toLowerCase()
      const modifiers: Record<string, boolean> = { cmd: true }
      if (parts.includes('Shift')) modifiers.shift = true
      if (parts.includes('Ctrl')) modifiers.ctrl = true
      expect(cmd(key, modifiers)).toBe(shortcut.command)
    }
  })
})
