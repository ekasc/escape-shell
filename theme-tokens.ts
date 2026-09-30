// The palette, in one place, so a component outside app.tsx can read it without
// importing the whole application. app.tsx had it inline, which made every
// other file that needed a colour either duplicate the hex or import app.tsx
// and create a cycle.

export const C = {
  // Warm-tinted darks — oklch 17% 0.015 45 family, not pure #1A1A1A gray
  canvas: '#1C1916',
  sidebar: '#201C19',
  raised: '#2B2622',
  composer: '#29241F',
  // Warm washes so hover doesn't flash blue-gray on a terracotta app
  overlay: '#F2E6D80D',
  overlayStrong: '#F2E6D817',
  item: '#F2E6D80F',
  border: '#3A332E',
  borderStrong: '#4A423C',
  sidebarBorder: '#2E2A26',
  text: '#F2E8DC',
  secondary: '#B8ADA3',
  tertiary: '#8A8178',
  // muted is de-emphasized *text*. tertiary and ghost are too dark to read on a
  // raised surface (ghost is 2.55:1, tertiary 3.91:1, against a 4.5 floor), and
  // they are still right for rules, chevrons and other non-text marks, which
  // only need 3:1. muted clears 5:1 on every surface, with headroom.
  muted: '#9D948A',
  ghost: '#6B6360',
  accent: '#E2795B',
  inverse: '#F2E6DC',
  onInverse: '#1C1916',
  codeText: '#E8A87C',
  success: '#5ED9A0',
  warning: '#EEB76B',
  error: '#F08080',
  // Semantic washes for badges/cards — translucent so text contrast stays 4.5:1
  successWash: '#5ED9A014',
  warningWash: '#EEB76B14',
  errorWash: '#F0808014',
  accentWash: '#E2795B14',
}


export type Palette = typeof C
