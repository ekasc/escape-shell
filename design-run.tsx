import { memo } from 'react'
import { motion } from '@gpuix/react'
import { C } from './theme-tokens'
import { DURATION, fadeIn } from './motion'

export type DesignPhase = { phase: string; pass: number; detail: string }

export type DesignOutcome = {
  passed: boolean
  repairs: number
  verdict: string
  why: string
  shots: { viewport: string; path: string }[]
  error: string
}

/**
 * The phases a run walks, in the order the engine walks them.
 *
 * Rendering the list from the run's own reports rather than from a fixed list
 * would show a phase twice if the engine ever reported one out of order, and
 * showing only what arrived would leave the reader guessing what is still to
 * come. This is the order, used to say which are done and which are next.
 */
export const DESIGN_PHASES = [
  'qualify',
  'brief',
  'brand',
  'page',
  'assets',
  'build',
  'preview',
  'capture',
  'review',
] as const

const PHASE_LABELS: Record<string, string> = {
  qualify: 'Reading the request',
  brief: 'Writing the brief',
  brand: 'Choosing the look',
  page: 'Planning the page',
  assets: 'Picking assets',
  build: 'Building',
  preview: 'Serving the page',
  capture: 'Photographing',
  review: 'Reviewing',
}

export function designPhaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase
}

/** The verdict line, which has to distinguish "not good enough" from "broke". */
export function designVerdictText(outcome: DesignOutcome): { text: string; tone: 'pass' | 'fail' } {
  if (outcome.error) return { text: outcome.error, tone: 'fail' }
  if (outcome.passed) return { text: 'Passed review', tone: 'pass' }
  const n = outcome.repairs
  const spent = `${n} repair${n === 1 ? '' : 's'}`
  return {
    text: outcome.why ? `Not accepted after ${spent} — ${outcome.why}` : `Not accepted after ${spent}`,
    tone: 'fail',
  }
}

const PHASES = memo(function DesignPhases({
  reported,
  done,
}: {
  reported: DesignPhase[]
  done: boolean
}) {
  const reached = new Map<string, DesignPhase>()
  for (const entry of reported) reached.set(entry.phase, entry)
  const furthest = DESIGN_PHASES.findIndex((p) => !reached.has(p))
  return (
    <div testId="design-phases" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {DESIGN_PHASES.map((phase, i) => {
        const entry = reached.get(phase)
        const isDone = done || entry !== undefined || (furthest >= 0 && i < furthest)
        const isCurrent = !done && i === furthest
        const color = isCurrent ? C.accent : isDone ? C.secondary : C.muted
        return (
          // A phase fading in marks it as the one that just happened. A run is
          // minutes long and reports a phase at a time, so each row arriving is
          // the only progress signal there is — without it the list sits still
          // and the run looks hung.
          <motion.div
            key={phase}
            {...fadeIn(DURATION.enter)}
            style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}
          >
            <text style={{ fontSize: 11, color }}>{isDone ? '·' : '○'}</text>
            <text style={{ fontSize: 12, color, fontWeight: isCurrent ? 600 : 400 }}>
              {designPhaseLabel(phase)}
            </text>
            {entry?.pass ? (
              <text style={{ fontSize: 11, color: C.muted }}>repair {entry.pass}/2</text>
            ) : null}
            {isCurrent && entry?.detail ? (
              <text style={{ fontSize: 11, color: C.muted }}>{entry.detail}</text>
            ) : null}
          </motion.div>
        )
      })}
    </div>
  )
})

export const DesignRun = memo(function DesignRun({
  reported,
  outcome,
}: {
  reported: DesignPhase[]
  outcome: DesignOutcome | null
}) {
  const done = outcome !== null
  const verdict = outcome ? designVerdictText(outcome) : null
  return (
    <div
      testId="design-run"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
        paddingLeft: 2,
        paddingTop: 2,
      }}
    >
      <PHASES reported={reported} done={done} />
      {verdict ? (
        // The verdict is the peak of the run: the moment a three-minute wait
        // resolves into an answer. It gets a slightly longer fade than a phase
        // row because it is the thing being waited for.
        <motion.div {...fadeIn(DURATION.overlay)}>
          <text
            style={{ fontSize: 12.5, fontWeight: 600, color: verdict.tone === 'pass' ? C.success : C.error }}
          >
            {verdict.text}
          </text>
        </motion.div>
      ) : null}
      {outcome && outcome.shots.length > 0 ? (
        <div testId="design-shots">
          <motion.div
            {...fadeIn(DURATION.overlay)}
            style={{ display: 'flex', flexDirection: 'row', gap: 10 }}
          >
          {outcome.shots.map((shot) => (
            <div key={shot.viewport} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {/* The real capture, from the path the engine wrote. These were
                  grey boxes standing in for images, which is worse than showing
                  nothing: a run reported a visual review and the reader saw two
                  empty rectangles. The engine writes a PNG per viewport and
                  sends its path, so there is nothing to invent. */}
              <img
                testId={`design-shot-${shot.viewport}`}
                src={shot.path}
                objectFit="cover"
                alt={`${shot.viewport.replace('shot-', '')} capture of the built page`}
                style={{
                  width: 220,
                  height: shot.viewport.includes('390') ? 476 : 153,
                  borderRadius: 5,
                  borderWidth: 1,
                  borderColor: C.border,
                }}
              />
              <text style={{ fontSize: 10.5, color: C.muted }}>
                {shot.viewport.replace('shot-', '')}
              </text>
            </div>
          ))}
          </motion.div>
        </div>
      ) : null}
    </div>
  )
})
