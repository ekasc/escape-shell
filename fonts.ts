/**
 * System font enumeration for the typography pickers.
 *
 * The curated fallback lists alone caused a real bug: picking a family that
 * is not installed (IBM Plex Sans, Lilex) silently falls back, so switching
 * fonts looked like a no-op. These pickers are therefore driven by the
 * families actually on the machine, with the curated lists as fallback when
 * enumeration is unavailable (browser web build, missing fontconfig).
 */

export interface FontOption {
  id: string
  label: string
  family: string
}

const KNOWN_MONO = new Set(
  [
    'menlo',
    'monaco',
    'courier',
    'courier new',
    'consolas',
    'andale mono',
    'anonymous pro',
    'letter gothic',
    'letter gothic std',
    'monofur',
    'bitstream vera sans mono',
    'dejavu sans mono',
    'liberation mono',
    'noto sans mono',
    'roboto mono',
    'sf mono',
    'sfnstext-mono',
  ].map((name) => name.toLowerCase()),
)

const MONO_HINT =
  /(mono|\bcode\b|\bcourier\b|\bconsole\b|\bterminal\b|\btypewriter\b|\bfixed\b|\bhack\b|\bfira\b|\bjetbrains\b|\binconsolata\b|\bdroid\b|\bproggy\b|\benvy\b)/i

/**
 * Parse `fc-list --format='%{family[0]}'` output into sorted, deduplicated
 * family names.
 *
 * One line per font face (never comma-joined aliases), backslash escapes
 * (`Heiti\-간체`) unescaped, private filler families (dot-prefixed) dropped.
 * The alias-splitting this replaces listed entries like "Noto Sans Kannada
 * Black" that are style names, not selectable families. Pure, so it is unit
 * tested without spawning anything.
 */
export function parseFontFamilies(output: string): string[] {
  const seen = new Map<string, string>()
  for (const line of output.split('\n')) {
    for (const part of line.split(',')) {
      const name = part.replace(/\\(.)/g, '$1').replace(/"/g, '').trim()
      if (name === '' || name.startsWith('.')) continue
      if (KNOWN_BROKEN.has(name.toLowerCase())) continue
      const key = name.toLowerCase()
      if (!seen.has(key)) seen.set(key, name)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * Families fontconfig lists that the renderer paints as the default font
 * anyway, measured by screenshot-diffing each family against a bogus name.
 * `Helvetica` resolves in fontconfig but never renders; `Helvetica Neue`
 * does.
 */
const KNOWN_BROKEN = new Set(['helvetica'])

/** A family is offered as monospace when it says so or is a known mono face. */
export function isMonoFamily(name: string): boolean {
  const lower = name.toLowerCase()
  return KNOWN_MONO.has(lower) || MONO_HINT.test(name)
}

export function toFontOption(name: string): FontOption {
  // Bare family name only. Measured against the renderer: quotes, comma
  // stacks, PostScript names, and generic families (`monospace`,
  // `system-ui`) all paint as the default font.
  return { id: name, label: name, family: name }
}

export interface SystemFonts {
  sans: FontOption[]
  mono: FontOption[]
}

export function splitSystemFonts(families: string[]): SystemFonts {
  return {
    sans: families.map((name) => toFontOption(name)),
    mono: families.filter(isMonoFamily).map((name) => toFontOption(name)),
  }
}

async function loadDesktopFamilies(): Promise<string[] | null> {
  try {
    const proc = Bun.spawnSync(['fc-list', '--format=%{family[0]}\\n', ':'], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 15000,
    } as Parameters<typeof Bun.spawnSync>[1])
    if (proc.exitCode !== 0 || !proc.stdout) return null
    const names = parseFontFamilies(proc.stdout.toString())
    return names.length > 0 ? names : null
  } catch {
    return null
  }
}

async function loadBrowserFamilies(): Promise<string[] | null> {
  try {
    const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> })
      .queryLocalFonts
    if (!query) return null
    const fonts = await query()
    const names = [...new Set(fonts.map((f) => f.family.trim()).filter((n) => n !== ''))].sort(
      (a, b) => a.localeCompare(b),
    )
    return names.length > 0 ? names : null
  } catch {
    return null
  }
}

let cache: Promise<SystemFonts | null> | null = null

/**
 * The installed families, once, shared by every settings open. Never throws:
 * null means "use the curated fallbacks".
 */
export function systemFonts(): Promise<SystemFonts | null> {
  if (!cache) {
    cache = (async () => {
      const families =
        typeof Bun !== 'undefined' ? await loadDesktopFamilies() : await loadBrowserFamilies()
      return families ? splitSystemFonts(families) : null
    })().catch(() => null)
  }
  return cache
}
