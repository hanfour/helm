import { z } from 'zod'
import { HOOK_MARKER } from './snippet.ts'

const HookEntry = z.object({ type: z.string(), command: z.string() }).passthrough()
const HookGroup = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookEntry).default([]),
}).passthrough()

/**
 * Only `PreToolUse` is validated, and only because helm writes into it.
 * Validating every event would let a hook shape helm has never heard of —
 * `{ type: 'prompt' }` exists today, and more will follow — block install for
 * everyone, over a key helm does not touch.
 */
const PreToolUseSchema = z.array(HookGroup)

/** Exactly what `buildHookCommand` emits, so nothing else can be mistaken for it. */
const COMMAND_PREFIX = 'exec node --no-warnings '

type Settings = Record<string, unknown>

const DESCRIPTION = 'helm —— 記錄此刻正在執行的工具'

/**
 * Adds exactly one entry, and never rewrites the file wholesale. This is the
 * user's own configuration, already carrying a plugin's worth of setup; the
 * only acceptable footprint is one entry that `removeHelmHook` can take back
 * out again leaving no trace.
 *
 * Returns the input unchanged when `hooks.PreToolUse` is not the shape we
 * understand — writing into something we cannot parse would destroy
 * configuration the user maintains by hand.
 */
export function addHelmHook(settings: unknown, command: string): Settings {
  const base = asRecord(settings)
  const hooks = base['hooks'] === undefined ? {} : base['hooks']
  if (!isRecord(hooks)) return base
  const existing = hooks['PreToolUse'] === undefined ? [] : hooks['PreToolUse']
  if (!PreToolUseSchema.safeParse(existing).success) return base

  return {
    ...base,
    hooks: {
      ...hooks,
      PreToolUse: [
        // Filtering first makes a repeat install an update rather than a
        // duplicate — the command string changes whenever the repo moves.
        ...(existing as unknown[]).filter((g) => !isHelmGroup(g)),
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
 * Leaves the file exactly as it was before install. An empty event array or an
 * empty `hooks` object would be residue, and residue is how "uninstall"
 * quietly becomes "mostly uninstall".
 *
 * Every event is scanned, not just `PreToolUse`: a copy someone moved to
 * `PostToolUse` by hand is still a live hook writing into ~/.helm/live, and
 * leaving it behind is the one thing uninstall must never do.
 */
export function removeHelmHook(settings: unknown): Settings {
  const base = asRecord(settings)
  const hooks = base['hooks']
  if (!isRecord(hooks)) return base

  const nextHooks = Object.fromEntries(
    Object.entries(hooks).flatMap(([event, groups]) => {
      if (!Array.isArray(groups)) return [[event, groups] as const]
      const kept = groups.filter((g) => !isHelmGroup(g))
      return kept.length === 0 ? [] : [[event, kept] as const]
    }),
  )
  if (JSON.stringify(nextHooks) === JSON.stringify(hooks)) return base
  return Object.keys(nextHooks).length > 0
    ? { ...base, hooks: nextHooks }
    : omit(base, 'hooks')
}

export function hasHelmHook(settings: unknown): boolean {
  const hooks = asRecord(settings)['hooks']
  if (!isRecord(hooks)) return false
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(isHelmGroup))
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
