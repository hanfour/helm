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
}

/** Contents of ~/.helm/live/<session_id>.json — always a single line. */
export interface LiveMarker {
  sessionId: string
  ts: number
  toolName: string
  summary: string
}

/** A session after lifecycle reconciliation. */
export interface SessionState extends DiscoveredSession {
  lifecycle: Lifecycle
  lifecycleConfidence: Confidence
  live: LiveMarker | null
}
