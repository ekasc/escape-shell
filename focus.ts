import { useCallback, useState } from 'react'
import { C } from './theme-tokens'

/**
 * A visible focus indicator, which the platform does not provide.
 *
 * WCAG 2.4.7 asks for one, and the app had none: there was no focus handling
 * anywhere, so a person tabbing through thirty controls could not tell which one
 * they were on. The style description offers `hover` and `active` variants and
 * nothing for focus, so this has to be driven by the focus events rather than
 * declared in the style.
 *
 * It is drawn as an inset box shadow rather than a border for two reasons. A
 * border would move every control by its own width, which is a visible change to
 * a layout that was tuned by eye. And a filled background would be
 * indistinguishable from hover, since hover is already a fill in this app, so
 * you could not tell which state you were in.
 */
export function useFocusRing(): {
  focused: boolean
  focusProps: { onFocus: () => void; onBlur: () => void }
  style: { boxShadow?: ReturnType<typeof focusRingForTest> }
} {
  const [focused, setFocused] = useState(false)
  const onFocus = useCallback(() => setFocused(true), [])
  const onBlur = useCallback(() => setFocused(false), [])
  return {
    focused,
    focusProps: { onFocus, onBlur },
    style: focused ? { boxShadow: focusRingForTest() } : {},
  }
}

/**
 * The ring itself: a 2px inset in the accent colour.
 *
 * Inset, so it sits inside the control's own bounds and costs no layout. Two
 * pixels rather than one because a single hairline is below the contrast that
 * makes an indicator perceivable, and this is the only thing telling a keyboard
 * user where they are.
 */
export function focusRingForTest(): {
  offsetX: number
  offsetY: number
  blurRadius: number
  spreadRadius: number
  color: string
} {
  return { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: -2, color: C.accent }
}
