import { z } from 'zod'
import { HOOK_MARKER } from './snippet.ts'

const HookEntry = z.object({ type: z.string(), command: z.string() }).passthrough()
const HookGroup = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookEntry).default([]),
}).passthrough()

/** Exactly what `buildHookCommand` emits, so nothing else can be mistaken for it. */
const COMMAND_PREFIX = 'exec node --no-warnings '

/**
 * Only the `hooks` key is described. Everything else in the user's
 * settings.json is carried through untouched and unvalidated — helm has no
 * business having an opinion about it.
 */
const SettingsSchema = z.object({
  hooks: z.record(z.string(), z.array(HookGroup)).optional(),
}).passthrough()

type Settings = Record<string, unknown>

const DESCRIPTION = 'helm —— 記錄此刻正在執行的工具'

/**
 * Adds exactly one entry, and never rewrites the file wholesale. This is the
 * user's own configuration, already carrying a plugin's worth of setup; the
 * only acceptable footprint is one entry that `removeHelmHook` can take back
 * out again leaving no trace.
 *
 * Returns the input unchanged when `hooks` is not the shape we understand —
 * writing into something we cannot parse would destroy configuration the user
 * maintains by hand.
 */
export function addHelmHook(settings: unknown, command: string): Settings {
  const base = asRecord(settings)
  if (!SettingsSchema.safeParse(base).success) return base
  const hooks = (base['hooks'] ?? {}) as Record<string, unknown[]>
  const existing = (hooks['PreToolUse'] ?? []) as unknown[]
  return {
    ...base,
    hooks: {
      ...hooks,
      PreToolUse: [
        // Filtering first makes a repeat install an update rather than a
        // duplicate — the command string changes whenever the repo moves.
        ...existing.filter((g) => !isHelmGroup(g)),
        {
          matcher: '*',
          // Async because this hook only ever records — it never inspects or
          // vetoes the tool call. Claude Code runs async hooks in the
          // background where they cannot block tool execution, which is what
          // keeps the recorder's ~190 ms spawn off the user's critical path.
          hooks: [{ type: 'command', command, async: true }],
          description: DESCRIPTION,
        },
      ],
    },
  }
}

/**
 * Leaves the file exactly as it was before install. An empty `PreToolUse`
 * array or an empty `hooks` object would be residue, and residue is how
 * "uninstall" quietly becomes "mostly uninstall".
 */
export function removeHelmHook(settings: unknown): Settings {
  const base = asRecord(settings)
  const hooks = base['hooks']
  if (!isRecord(hooks)) return base
  const existing = Array.isArray(hooks['PreToolUse']) ? hooks['PreToolUse'] : []
  const kept = existing.filter((g) => !isHelmGroup(g))
  if (kept.length === existing.length) return base

  const nextHooks = kept.length > 0
    ? { ...hooks, PreToolUse: kept }
    : omit(hooks, 'PreToolUse')
  return Object.keys(nextHooks).length > 0
    ? { ...base, hooks: nextHooks }
    : omit(base, 'hooks')
}

export function hasHelmHook(settings: unknown): boolean {
  const hooks = asRecord(settings)['hooks']
  if (!isRecord(hooks)) return false
  const pre = hooks['PreToolUse']
  return Array.isArray(pre) && pre.some(isHelmGroup)
}

/**
 * Identified by shape, not by a substring of the whole group. Matching on
 * "this JSON mentions HELM_LIVE_MARKER anywhere" would silently delete a
 * third-party hook that merely asks whether helm is installed — a very
 * reasonable thing for an audit script to do, and unrecoverable once
 * uninstall has run.
 *
 * The marker is still required, so a group helm did not write is never
 * touched even if it happens to share the shape.
 */
function isHelmGroup(group: unknown): boolean {
  if (!isRecord(group) || group['matcher'] !== '*') return false
  const hooks = group['hooks']
  if (!Array.isArray(hooks) || hooks.length !== 1) return false
  const entry = hooks[0]
  if (!isRecord(entry) || typeof entry['command'] !== 'string') return false
  return entry['command'].startsWith(COMMAND_PREFIX) && entry['command'].includes(HOOK_MARKER)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asRecord(v: unknown): Settings {
  return isRecord(v) ? v : {}
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
}
