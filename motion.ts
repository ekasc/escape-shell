/**
 * Motion vocabulary.
 *
 * One place for every duration and curve in the shell, because the alternative
 * is a `transition` inline in whichever component someone was editing that day,
 * and the timings drift apart until the app feels like four apps.
 *
 * Two constraints shape what is here, and both come from GPUIX rather than from
 * taste:
 *
 * 1. **Only opacity, position, size and radius are animatable.** There is no
 *    transform and no scale, so the usual advice to animate transform and
 *    nothing else is not available: opacity is the cheap property here and
 *    everything else is a layout property. That makes opacity the default, and
 *    it is why nothing in the shell animates a position.
 * 2. **Durations are in seconds**, and the intent is milliseconds. The constants
 *    below are milliseconds because that is how timings are reasoned about; the
 *    conversion happens once, in `transition()`.
 */

/** Milliseconds. Kept in ms because that is the unit a timing is judged in. */
export const DURATION = {
  /** Hover, focus rings, colour changes. Anything a pointer is already over. */
  micro: 120,
  /** A control appearing or a row settling into place. */
  enter: 180,
  /**
   * A dialog or sheet. The largest thing the shell animates, and still well
   * inside the 300ms ceiling past which an interface feels like it is lagging
   * behind the click.
   */
  overlay: 220,
  /**
   * Leaving. Deliberately shorter than arriving: a dismissal the reader has
   * already asked for should not hold them for the full enter duration.
   */
  exit: 140,
} as const

/**
 * Curves, as cubic-bezier control points.
 *
 * The built-in `easeOut` is the weak one: it is a symmetric ease that starts
 * at 68% of its distance, which reads as a soft start. `out` is the standard
 * decelerate — fast out of the gate, long settle — and it is the default for
 * anything responding to a click. `inOut` is only for movement that starts and
 * ends on screen.
 */
export const EASE = {
  /** Decelerate. The default for enter, exit, and anything user-initiated. */
  out: [0, 0, 0.2, 1] as [number, number, number, number],
  /** Accelerate, for leaving. Mirrors `out` so the two do not fight. */
  in: [0.4, 0, 1, 1] as [number, number, number, number],
  /** For motion that both starts and ends in view, like a reposition. */
  inOut: [0.4, 0, 0.2, 1] as [number, number, number, number],
} as const

export type EaseName = keyof typeof EASE

let reducedMotionCache: boolean | null = null

/**
 * Whether the OS asks for reduced motion.
 *
 * GPUIX exposes no reduced-motion signal — no media query, no host value — so
 * the platform preference has to be read directly. On macOS it is
 * `NSReduceMotion`, which is absent when the user has never touched the setting
 * and that means motion is allowed.
 *
 * Read once and cached. This is a boot-time preference, and spawning a process
 * to read it on every render would be absurd.
 */
export function prefersReducedMotion(): boolean {
  if (reducedMotionCache !== null) return reducedMotionCache
  let value = false
  try {
    const probe = Bun.spawnSync(['defaults', 'read', '-g', 'NSReduceMotion'])
    // The key is absent when the preference was never set, which `defaults`
    // reports as a non-zero exit rather than as a value.
    if (probe.exitCode === 0) value = probe.stdout.toString().trim() === '1'
  } catch {
    // No `defaults`, or a platform without the preference. Animating is the
    // better failure: motion is a nicety, and a missing probe is not a reason
    // to freeze the interface.
  }
  reducedMotionCache = value
  return value
}

/** Test seam, so the reduced-motion path can be exercised without the OS. */
export function __setReducedMotionForTest(value: boolean | null): void {
  reducedMotionCache = value
}

export interface Transition {
  duration: number
  delay: number
  ease: [number, number, number, number]
}

/**
 * Builds a GPUIX transition, in seconds, honouring reduced motion.
 *
 * Reduced motion keeps the fade and drops the travel rather than removing
 * animation wholesale: an instant appearance still tells the reader something
 * arrived, whereas no change at all can read as a missed repaint.
 */
export function transition(
  ms: number,
  ease: EaseName = 'out',
  delayMs = 0,
): Transition {
  const scale = prefersReducedMotion() ? 0 : 1
  return {
    duration: (ms / 1000) * scale,
    delay: (delayMs / 1000) * scale,
    ease: EASE[ease],
  }
}

/**
 * A fade, which is the default entrance for anything in the shell.
 *
 * Opacity only, and only because it is the one property GPUIX can animate that
 * does not trigger layout.
 */
export function fadeIn(ms: number = DURATION.enter, ease: EaseName = 'out') {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: transition(ms, ease),
  }
}
