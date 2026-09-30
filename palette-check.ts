/**
 * Checks a candidate palette against WCAG 2.2 before it reaches the app.
 *
 * The point is that contrast is decided here, on a table, rather than discovered
 * later by reading pixels back off a canvas. A token that fails here never gets
 * written into `C`, so there is no version of this palette that is only correct
 * on a light monitor.
 *
 * Three tiers of edge, because WCAG only asks for one of them to be loud:
 *
 *   border       decorative hairline   no floor — a divider, not a control
 *   borderStrong a state boundary      3:1  — identifies a control or its state
 *   rule         the 2px structural    2.2:1 — visible as a deliberate edge
 *                edge                       without reading as a wireframe
 *
 *   bun run palette
 */

type Hex = string
type Surface = keyof typeof SURFACES

const SURFACES = {
  canvas: '#0A0C0EF2',
  header: '#0A0C0E',
  sidebar: '#101317ED',
  surface: '#14171C',
  surfaceAlt: '#1A1E24',
  raised: '#21262D',
  surfaceHigh: '#2A3038',
  surfaceActive: '#333A43',
  composer: '#181C22F0',
} as const

const INK = {
  text: '#F2F4F7',
  secondary: '#A8B0BA',
  tertiary: '#7D858F',
  ghost: '#78787E',
  accent: '#89A6FF',
  accentHover: '#9AB3FF',
  accentPressed: '#7592F0',
  success: '#4ADE9B',
  warning: '#F0B45C',
  error: '#FF8A8A',
  purple: '#A79BF5',
} as const

type Ink = keyof typeof INK

function lum(hex: Hex): number {
  const h = hex.replace('#', '').slice(0, 6)
  const v = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
}

function ratio(a: Hex, b: Hex): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The floor each ink clears on the surface it is actually allowed to sit on. */
const FLOOR: Record<Ink, { min: number; why: string }> = {
  text: { min: 7, why: 'body' },
  secondary: { min: 4.5, why: 'supporting copy' },
  tertiary: { min: 3, why: 'metadata' },
  ghost: { min: 3, why: 'disabled text' },
  accent: { min: 4.5, why: 'interactive label' },
  accentHover: { min: 4.5, why: 'interactive label' },
  accentPressed: { min: 4.5, why: 'interactive label' },
  success: { min: 3, why: 'status' },
  warning: { min: 3, why: 'status' },
  error: { min: 4.5, why: 'error label' },
  purple: { min: 4.5, why: 'needs-input label' },
}

/** Where each ink is genuinely used. A pair that does not exist is not a test. */
const ALLOWED: Record<Ink, Surface[]> = {
  text: ['canvas', 'header', 'sidebar', 'surface', 'surfaceAlt', 'raised', 'surfaceHigh', 'surfaceActive'],
  secondary: ['canvas', 'header', 'sidebar', 'surface', 'surfaceAlt', 'raised', 'surfaceHigh'],
  tertiary: ['canvas', 'header', 'sidebar', 'surface', 'surfaceAlt', 'raised', 'surfaceHigh', 'surfaceActive'],
  ghost: ['canvas', 'header', 'sidebar', 'surface', 'raised', 'surfaceHigh'],
  accent: ['canvas', 'sidebar', 'surface', 'surfaceAlt', 'raised', 'surfaceHigh', 'surfaceActive'],
  accentHover: ['canvas', 'surface', 'surfaceAlt', 'raised'],
  accentPressed: ['canvas', 'surface', 'surfaceAlt', 'raised'],
  success: ['canvas', 'sidebar', 'surface', 'surfaceAlt', 'raised'],
  warning: ['canvas', 'sidebar', 'surface', 'surfaceAlt', 'raised'],
  error: ['canvas', 'sidebar', 'surface', 'surfaceAlt', 'raised'],
  purple: ['canvas', 'sidebar', 'surface', 'surfaceAlt', 'raised'],
}

const EDGES: Array<{ name: string; hex: Hex; min: number; why: string; on: Surface[] }> = [
  { name: 'border', hex: '#424245', min: 1.5, why: 'decorative hairline — must be a perceptible edge, not an artifact', on: ['canvas', 'header', 'sidebar', 'surface', 'surfaceAlt', 'raised'] },
  { name: 'borderStrong', hex: '#6F6F73', min: 3, why: 'state boundary on a control', on: ['surface', 'surfaceAlt', 'raised', 'composer'] },
  { name: 'rule', hex: '#545457', min: 2.2, why: 'the 2px structural edge', on: ['canvas', 'header', 'surface', 'surfaceAlt'] },
]

let failures = 0
const out = (s = '') => process.stdout.write(`${s}\n`)

out('\nink — worst allowed surface')
out(`${'ink'.padEnd(14)}${'floor'.padStart(6)}  ${'worst pair'.padEnd(28)}${'ratio'.padStart(7)}`)
for (const name of Object.keys(INK) as Ink[]) {
  let worst: [string, number] = ['', Infinity]
  for (const s of ALLOWED[name]) {
    const r = ratio(INK[name], SURFACES[s])
    if (r < worst[1]) worst = [s, r]
  }
  const ok = worst[1] >= FLOOR[name].min
  if (!ok) failures++
  out(`${name.padEnd(14)}${String(FLOOR[name].min).padStart(6)}  ${worst[0].padEnd(28)}${worst[1].toFixed(2).padStart(7)}  ${ok ? 'ok' : `FAIL — ${FLOOR[name].why}`}`)
}

out('\nedges')
for (const e of EDGES) {
  let worst: [string, number] = ['', Infinity]
  for (const s of e.on) {
    const r = ratio(e.hex, SURFACES[s])
    if (r < worst[1]) worst = [s, r]
  }
  const ok = worst[1] >= e.min
  if (!ok) failures++
  out(`${e.name.padEnd(14)}${String(e.min).padStart(6)}  ${worst[0].padEnd(28)}${worst[1].toFixed(2).padStart(7)}  ${ok ? 'ok' : `FAIL — ${e.why}`}`)
}

out('\naccent on accentInk — a filled control carrying text')
const onAccent = ratio('#0A0C0E', INK.accent)
out(`${'ink on accent'.padEnd(14)}${String(4.5).padStart(6)}  ${'accent'.padEnd(28)}${onAccent.toFixed(2).padStart(7)}  ${onAccent >= 4.5 ? 'ok' : 'FAIL — label on the filled control'}`)
if (onAccent < 4.5) failures++

out(`\n${failures === 0 ? 'PASS' : `${failures} FAILURES`}`)
process.exit(failures === 0 ? 0 : 1)
