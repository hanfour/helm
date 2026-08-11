import type { StatusKey } from '../session-status.ts'
import type { Confidence } from '../types.ts'

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

/** The uncolored mark, so callers that need to align columns can measure it. */
export function markOf(key: StatusKey, confidence: Confidence): string {
  return `${SHAPE[key]}${confidence === 'low' ? '?' : ''}`
}

export function paint(key: StatusKey, text: string, color: boolean): string {
  return color ? `${COLOR[key]}${text}${RESET}` : text
}

export function glyph(key: StatusKey, confidence: Confidence, color: boolean): string {
  return paint(key, markOf(key, confidence), color)
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
