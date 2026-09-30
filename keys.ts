/**
 * Key names, in one place.
 *
 * GPUI does not use the DOM's spelling for the arrow keys. Its own components
 * compare against `"up"` and `"down"`, never `"ArrowUp"` — see
 * `ComboboxInput` in @gpuix/react, which is the platform's own
 * filter-and-select control and therefore the authority on what a key press
 * actually arrives as.
 *
 * The test renderer is a different system and spells them the DOM way, so the
 * two genuinely disagree: `nativeSimulateKeyDown(id, 'arrowdown')` is a real
 * event, and on the real window the same key is `down`. Anything that compares
 * key names has to go through here, because a handler written against one
 * spelling is silently dead on the other.
 *
 * This is not defensive coding. The arrow keys did not work in the app while
 * every test passed, because the tests exercised the harness's spelling.
 */

/** A key press, normalised. */
export type NormalKey =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'enter'
  | 'escape'
  | 'space'
  | 'tab'
  | 'backspace'
  | 'other'

/**
 * Maps whatever the platform sent onto one name.
 *
 * Both spellings are accepted because both are real: GPUI sends `down`, the
 * test renderer sends `arrowdown`, and code under test has to behave the same
 * under both or the tests are measuring something the app never does.
 */
export function normaliseKey(raw: string | undefined): NormalKey {
  if (!raw) return 'other'
  switch (raw.toLowerCase()) {
    // GPUI's own spelling, and the DOM's, for the same physical key.
    case 'up':
    case 'arrowup':
      return 'up'
    case 'down':
    case 'arrowdown':
      return 'down'
    case 'left':
    case 'arrowleft':
      return 'left'
    case 'right':
    case 'arrowright':
      return 'right'
    case 'home':
      return 'home'
    case 'end':
      return 'end'
    case 'enter':
    case 'return':
    case 'numpadenter':
      return 'enter'
    case 'escape':
    case 'esc':
      return 'escape'
    // GPUI names the space bar "space"; the DOM delivers " ".
    case 'space':
    case ' ':
    case 'spacebar':
      return 'space'
    case 'tab':
      return 'tab'
    case 'backspace':
    case 'delete':
      return 'backspace'
    default:
      return 'other'
  }
}
