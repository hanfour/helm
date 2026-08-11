import { z } from 'zod'
import { HOOK_MARKER } from './snippet.ts'

const HookEntry = z.object({ type: z.string(), command: z.string() }).passthrough()
const HookGroup = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookEntry).default([]),
}).passthrough()

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
        { matcher: '*', hooks: [{ type: 'command', command }], description: DESCRIPTION },
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

/** Matches on the embedded marker, not on paths — the repo may have moved. */
function isHelmGroup(group: unknown): boolean {
  return JSON.stringify(group ?? null).includes(HOOK_MARKER)
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
