import type { TaskStatus } from './task-status.ts'

export type Lifecycle = 'running' | 'ended_clean' | 'crashed'
export type Confidence = 'high' | 'low'
export type NativeStatus = 'busy' | 'idle'

/** One raw ~/.claude/sessions/<PID>.json file. */
export interface RegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  procStart: string
  kind: string
  name: string
  status: NativeStatus | null
  updatedAt: number
}

/** A session found by an adapter, before lifecycle is decided. */
export interface DiscoveredSession {
  adapterId: string
  sessionId: string
  cwd: string
  pid: number | null
  procStart: string | null
  startedAt: number
  updatedAt: number
  nativeStatus: NativeStatus | null
  kind: string
  name: string
  transcriptPath: string | null
  /**
   * Carried from the directory scan that already stat'ed this file. Null when
   * the path came from somewhere that did not stat it; reconciliation then
   * falls back to asking the filesystem.
   */
  transcriptMtimeMs: number | null
}

/** Contents of ~/.helm/live/<session_id>.json — always a single line. */
export interface LiveMarker {
  sessionId: string
  ts: number
  toolName: string
  summary: string
  /**
   * The file was there but its body could not be used. The timestamp still
   * holds — it comes from the file's mtime — so crash detection is unaffected;
   * what is lost is *which* tool was running, and with it the right to claim
   * high confidence.
   */
  degraded: boolean
}

/** A session after lifecycle reconciliation. */
export interface SessionState extends DiscoveredSession {
  lifecycle: Lifecycle
  lifecycleConfidence: Confidence
  live: LiveMarker | null
  /**
   * 從交接簡報來的任務狀態，未知時為 null。
   *
   * adapter 產不出這個值（它來自簡報快取），所以 adapter 一律填 null，
   * 由 `attachTaskStatus` 在 collectStatus 裡補上。
   */
  taskStatus: TaskStatus | null
}
