import type { PrefRead, PrefsIO } from './defaults.ts'

/**
 * Fakes for the two GUI apps' preference domains.
 *
 * Every test that reaches install, uninstall or doctor must inject one of
 * these. Twice now a test has reached the real `defaults` database instead:
 * once writing a temp path into Übersicht's own `widgetDir`, once reading
 * SwiftBar's live `PluginDirectory` and installing a fixture's plugin over the
 * working one. Neither failed; both were found by reading `defaults` by hand.
 */
export const NO_PREFS: PrefsIO = {
  readPref: () => ({ kind: 'unset' }),
  writePref: () => {},
  clearPref: () => {},
}

export interface FakePrefs extends PrefsIO {
  store: Record<string, string>
}

/** A domain that starts empty unless seeded, and remembers what was written. */
export function fakePrefs(seed: Record<string, string> = {}): FakePrefs {
  const store = { ...seed }
  return {
    store,
    readPref: (key) => (store[key] === undefined ? { kind: 'unset' } : { kind: 'set', value: store[key] }),
    writePref: (key, value) => {
      store[key] = value
    },
    clearPref: (key) => {
      delete store[key]
    },
  }
}

/** A domain helm cannot read at all — distinct from one that is empty. */
export function unreadablePrefs(reason = 'ENOBUFS'): FakePrefs {
  return {
    store: {},
    readPref: () => ({ kind: 'unreadable', reason }),
    writePref: () => {
      throw new Error('讀不到設定時不該寫入')
    },
    clearPref: () => {
      throw new Error('讀不到設定時不該刪除')
    },
  }
}
