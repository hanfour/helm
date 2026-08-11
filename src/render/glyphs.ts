import type { Confidence, SessionState } from '../types.ts'

export type StatusKey = 'busy' | 'idle' | 'ended' | 'crashed'

const ESC = '\u001b'
const RESET = `${ESC}[0m`

const COLOR: Record<StatusKey, string> = {
  busy: `${ESC}[32m`,    // green
  idle: `${ESC}[32m`,    // green
  ended: `${ESC}[90m`,   // bright black
  crashed: `${ESC}[31m`, // red
}

const SHAPE: Record<StatusKey, string> = {
  busy: '●',
  idle: '○',
  ended: '●',
  crashed: '●',
}

/** Spec 11.1. A crashed session is crashed regardless of what the registry claimed. */
export function statusOf(s: SessionState): StatusKey {
  if (s.lifecycle === 'crashed') return 'crashed'
  if (s.lifecycle === 'ended_clean') return 'ended'
  return s.nativeStatus === 'busy' ? 'busy' : 'idle'
}

export function glyph(key: StatusKey, confidence: Confidence, color: boolean): string {
  const mark = `${SHAPE[key]}${confidence === 'low' ? '?' : ''}`
  return color ? `${COLOR[key]}${mark}${RESET}` : mark
}

export function dim(text: string, color: boolean): string {
  return color ? `${ESC}[90m${text}${RESET}` : text
}

const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

export function relativeTime(fromMs: number, nowMs: number): string {
  const d = nowMs - fromMs
  if (d < MINUTE) return '剛剛'
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分鐘前`
  if (d < DAY) return `${Math.floor(d / HOUR)} 小時前`
  return `${Math.floor(d / DAY)} 天前`
}
