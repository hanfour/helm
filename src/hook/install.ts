import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { HelmPaths } from '../paths.ts'
import { addHelmHook, hasHelmHook, removeHelmHook } from './settings.ts'
import { buildHookCommand, HOOK_MARKER, shellQuote } from './snippet.ts'
import {
  adoptPluginDir, defaultPluginDir, defaultSwiftBarDeps, PLUGIN_NAME, releasePluginDir,
  resolvePluginDir, type SwiftBarDeps,
} from './swiftbar.ts'
import {
  adoptWidgetDir, defaultUbersichtDeps, defaultWidgetDir, releaseWidgetDir, resolveWidgetDir,
  type UbersichtDeps,
} from './ubersicht.ts'
import type { ScannedDir } from './scan-dir.ts'
import { appInstalled } from './app-present.ts'
import { buildWidget, WIDGET_MARKER, WIDGET_NAME } from './widget.ts'

const SWIFTBAR_APP = '/Applications/SwiftBar.app'
const UBERSICHT_APP = '/Applications/Übersicht.app'
const SWIFTBAR_BUNDLE = 'com.ameba.SwiftBar'
const UBERSICHT_BUNDLE = 'tracesOf.Uebersicht'

/**
 * Written into every script helm generates, so uninstall can tell its own
 * files apart from anything that happened to be sitting at the same path.
 * `helm` is also the name of the Kubernetes client, and ~/.local/bin is
 * exactly where a user keeps their own binaries.
 */
const SCRIPT_MARKER = `# ${HOOK_MARKER}`

/** The same marker as a JS comment: an Übersicht widget is an ES module. */
const WIDGET_COMMENT = `// ${WIDGET_MARKER}`

/**
 * Stamped into every generated file so helm can tell "I wrote this and it is
 * untouched" from "I wrote this and the user has since edited it".
 *
 * The marker alone cannot: it sits on line one, nobody deletes it, and the
 * widget's own header invites the user to edit the file. So every edit was
 * being overwritten on the next install — silently, and reported as a
 * successful install.
 */
const HASH_LABEL = 'helm-content'

function stamped(body: string, comment: string): string {
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
  return `${body}${comment} ${HASH_LABEL}:${digest}\n`
}

/**
 * True when the file is byte-for-byte what helm last wrote.
 *
 * A file with no stamp at all was written by a helm from before this existed,
 * so it belongs to helm and may be replaced. That does mean a user who edits
 * the file *and* deletes the stamp line loses their changes — but the stamp
 * sits at the very bottom under its own comment, and someone editing colours
 * or a position has no reason to remove it.
 */
function isUnmodified(path: string): boolean {
  let body: string
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  const match = new RegExp(`^(?:#|//) ${HASH_LABEL}:([0-9a-f]{16})\\n$`, 'm').exec(body)
  if (match?.[1] === undefined) return true
  const original = body.slice(0, body.length - match[0].length)
  return createHash('sha256').update(original).digest('hex').slice(0, 16) === match[1]
}

export interface InstallDeps {
  now: () => number
  repoRoot: string
  /** Absolute interpreter path; see `nodeInvocation`. */
  nodeBin?: string
  /** Injected so the SwiftBar branches are testable on any machine. */
  swiftbarInstalled?: boolean
  swiftbar?: SwiftBarDeps
  /** Likewise for the desktop widget. */
  ubersichtInstalled?: boolean
  ubersicht?: UbersichtDeps
}

export interface InstallReport {
  steps: string[]
  warnings: string[]
  /** False when something helm intended to do did not happen. */
  ok: boolean
}

/**
 * The only place helm touches configuration it does not own. Three rules,
 * in order: back up first, append rather than overwrite, and refuse outright
 * anything we cannot read — because writing our hook into a settings.json we
 * failed to parse would destroy every setting the user has.
 */
export function installHook(paths: HelmPaths, deps: InstallDeps): InstallReport {
  const settings = readSettings(paths.claudeSettings)
  if (settings === UNREADABLE) {
    return {
      steps: [],
      ok: false,
      warnings: [`${paths.claudeSettings} 無法解析或頂層不是物件，已中止安裝。helm 不會覆寫看不懂的設定檔 —— 請先修好它再重跑。`],
    }
  }

  const nodeBin = deps.nodeBin ?? process.execPath
  const command = buildHookCommand(paths.helmLive, paths.hookErrorsLog, undefined, nodeBin)
  const result = addHelmHook(settings, command)
  if (result.kind === 'refused') {
    return {
      steps: [],
      ok: false,
      warnings: [`${paths.claudeSettings} 的 ${result.reason}，已中止安裝，原檔未動。`],
    }
  }

  const steps: string[] = []
  const warnings: string[] = []
  try {
    apply(paths, deps, result, steps, warnings, nodeBin)
  } catch (err) {
    // The machine may already have been changed by the time we get here.
    // Reporting only the exception would leave the user believing nothing
    // happened — and so not running uninstall — while the hook is live.
    warnings.push(`安裝中途失敗：${err instanceof Error ? err.message : String(err)}`)
    warnings.push('上面列出的步驟已經生效。要收回請執行 helm uninstall，或設 HELM_OFF=1 先停用 hook。')
    return { steps, warnings, ok: false }
  }
  return { steps, warnings, ok: true }
}

/** Everything that mutates the machine, so the caller can report a partial run. */
function apply(
  paths: HelmPaths,
  deps: InstallDeps,
  result: { kind: 'updated' | 'unchanged'; settings: unknown },
  steps: string[],
  warnings: string[],
  nodeBin: string,
): void {
  // Only the state before helm ever touched the file is worth keeping. A
  // second backup would capture settings.json *with* the hook already in it,
  // and a user restoring "the most recent backup" would get helm back —
  // exactly the opposite of what they asked for. The pid guards against two
  // installs in the same millisecond overwriting each other's copy.
  if (existsSync(paths.claudeSettings) && !hasHelmHook(readSettings(paths.claudeSettings))) {
    const stamp = new Date(deps.now()).toISOString().replace(/:/g, '-')
    const backup = join(paths.backupsDir, `settings-${stamp}.${process.pid}.json`)
    mkdirSync(paths.backupsDir, { recursive: true })
    writeBackup(backup, readFileSync(paths.claudeSettings, 'utf8'))
    steps.push(`已備份安裝前的設定到 ${backup}`)
  }

  // The hook must not spawn `mkdir` — measured at 2.5 ms on every single tool
  // call — so the directory has to exist before the first one arrives.
  mkdirSync(paths.helmLive, { recursive: true })
  steps.push(`已建立 ${paths.helmLive}`)

  if (result.kind === 'updated') {
    writeJsonAtomic(paths.claudeSettings, result.settings)
    steps.push(`已把 hook 加進 ${paths.claudeSettings}（其餘設定未動）`)
  } else {
    // Saying "added the hook" here would be a lie, and this is the one command
    // that edits a file helm does not own — the user has to be able to trust
    // every line of its output.
    steps.push(`${paths.claudeSettings} 的 hook 已經是最新的，未改動`)
  }

  const entryRaw = join(deps.repoRoot, 'src/cli/main.ts')
  const entry = shellQuote(entryRaw)
  const wrapper = wrapperPath(paths)
  const wrapperOk = writeOurScript(wrapper, `#!/bin/sh\n${nodeInvocation(nodeBin)}\nexec "$NODE" ${entry} "$@"\n`)
  if (wrapperOk) steps.push(`已安裝 ${wrapper}`)
  else if (isSymlink(wrapper)) warnings.push(refusedSymlink(wrapper))
  else warnings.push(`${wrapper} 已經存在且不是 helm 寫的（Kubernetes 的 helm 也叫這個名字），未覆寫。想用 helm 指令請自行改名或換一個位置。`)

  const invocation = { wrapper, wrapperOk, entryRaw, nodeBin }
  // Each integration is isolated. They are independent features, and a
  // read-only SwiftBar folder used to abort `apply()` outright — the desktop
  // widget was never installed, and even the PATH warning went unprinted.
  isolate('SwiftBar', () => installPlugin(paths, deps, invocation, steps, warnings), warnings)
  isolate('Übersicht', () => installWidget(paths, deps, invocation, steps, warnings), warnings)

  if (!onPath(dirname(wrapper))) {
    warnings.push(`${dirname(wrapper)} 不在 PATH 上，直接打 helm 會找不到。把它加進 shell 設定即可。`)
  }
  warnings.push('hook 要等下一個 Claude Code session 啟動才會生效。')
}

function isolate(label: string, run: () => void, warnings: string[]): void {
  try {
    run()
  } catch (err) {
    warnings.push(
      `${label} 這部分失敗了：${err instanceof Error ? err.message : String(err)}。`
      + '其餘部分照常安裝完成。',
    )
  }
}

interface Invocation {
  wrapper: string
  wrapperOk: boolean
  /** Unquoted. The widget quotes every argument itself. */
  entryRaw: string
  nodeBin: string
}

/**
 * The desktop half of the board, for people who never find a menu bar item
 * among twenty others. Übersicht draws a shell command's output straight onto
 * the wallpaper, which is exactly the shape helm already produces.
 */
function installPlugin(
  paths: HelmPaths,
  deps: InstallDeps,
  invocation: Invocation,
  steps: string[],
  warnings: string[],
): void {
  if (!(deps.swiftbarInstalled ?? appInstalled(SWIFTBAR_APP, SWIFTBAR_BUNDLE))) {
    warnings.push('找不到 SwiftBar，選單列看板尚未啟用。安裝方式：brew install --cask swiftbar，裝好後重跑 helm install。')
    return
  }
  const swiftbar = deps.swiftbar ?? defaultSwiftBarDeps()
  // Install into the folder SwiftBar actually scans. Putting the plugin
  // anywhere else is the silent dead end this whole path guards against:
  // every file in place, every check green, and an empty menu bar.
  const scan = resolvePluginDir(paths, swiftbar)
  if (!usable(scan, warnings)) return
  const plugin = join(scan.dir, PLUGIN_NAME)
  // Absolute path: SwiftBar runs plugins with a minimal PATH that will not
  // contain ~/.local/bin. Falls back to the entry point directly when the
  // wrapper is somebody else's file.
  const body = invocation.wrapperOk
    ? `#!/bin/sh\nexec ${shellQuote(invocation.wrapper)} menu\n`
    : `#!/bin/sh\n${nodeInvocation(invocation.nodeBin)}\nexec "$NODE" ${shellQuote(invocation.entryRaw)} menu\n`
  if (writeOurScript(plugin, body)) {
    steps.push(`已安裝 SwiftBar plugin：${plugin}`)
  } else {
    warnings.push(refusal(plugin))
  }
  // Writing this before SwiftBar's first launch skips its folder picker —
  // a manual, GUI-only step helm cannot perform, and one that hides the
  // failure completely when it is left undone.
  if (scan.adoptable) {
    adoptPluginDir(scan.dir, swiftbar)
    steps.push(`已把 SwiftBar 的 plugin 資料夾設為 ${scan.dir}`)
  }
}

/** Narrows to a writable folder, pushing the resolution's warning if not. */
function usable(scan: ScannedDir, warnings: string[]): scan is ScannedDir & { dir: string } {
  if (scan.warning !== null) warnings.push(scan.warning)
  return scan.dir !== null
}

function installWidget(
  paths: HelmPaths,
  deps: InstallDeps,
  invocation: Invocation,
  steps: string[],
  warnings: string[],
): void {
  if (!(deps.ubersichtInstalled ?? appInstalled(UBERSICHT_APP, UBERSICHT_BUNDLE))) {
    warnings.push('找不到 Übersicht，桌面看板尚未啟用。安裝方式：brew install --cask ubersicht，裝好後重跑 helm install。')
    return
  }
  const ubersicht = deps.ubersicht ?? defaultUbersichtDeps()
  const scan = resolveWidgetDir(paths, ubersicht)
  if (!usable(scan, warnings)) return
  const widget = join(scan.dir, WIDGET_NAME)
  // Same fallback as the SwiftBar plugin: when ~/.local/bin/helm belongs to
  // somebody else, call the entry point directly rather than draw nothing.
  const argv = invocation.wrapperOk
    ? [invocation.wrapper, 'status', '--json']
    : [invocation.nodeBin, invocation.entryRaw, 'status', '--json']
  // 0644, not 0755: a widget is a module Übersicht imports, not a program it
  // runs, and an executable bit here would only be noise.
  if (writeOurFile(widget, stamped(buildWidget(argv), '//'), 0o644)) {
    steps.push(`已安裝桌面 widget：${widget}`)
  } else {
    warnings.push(refusal(widget))
  }
  warnings.push(
    '桌面 widget 要能用滑鼠拖曳，需要在 Übersicht 偏好裡開啟 Enable interaction。'
    + '開了之後 widget 那塊區域會擋住底下桌面圖示的點擊 —— 這是它的代價，由你決定。',
  )
  if (scan.adoptable) {
    adoptWidgetDir(scan.dir, ubersicht)
    steps.push(`已把 Übersicht 的 widget 資料夾設為 ${scan.dir}`)
    // Übersicht fixes the folder as an argv at launch, so a running instance
    // is still scanning the old one. helm warns about the hook needing a new
    // session; this deserves the same.
    warnings.push('Übersicht 啟動時就把 widget 資料夾固定住了，請重新啟動它才會看到桌面看板。')
  }
}

export function uninstallHook(paths: HelmPaths, deps: InstallDeps): InstallReport {
  const steps: string[] = []
  const warnings: string[] = []

  const settings = readSettings(paths.claudeSettings)
  if (settings === UNREADABLE) {
    warnings.push(`${paths.claudeSettings} 無法解析，未改動它。hook 設定可能還留著，請自行檢查。`)
  } else if (hasHelmHook(settings)) {
    // Uninstall is the side that deletes, so it gets a backup too. Install had
    // one from the start and this did not, which was exactly backwards.
    const stamp = new Date(deps.now()).toISOString().replace(/:/g, '-')
    const backup = join(paths.backupsDir, `settings-before-uninstall-${stamp}.${process.pid}.json`)
    mkdirSync(paths.backupsDir, { recursive: true })
    writeBackup(backup, readFileSync(paths.claudeSettings, 'utf8'))
    steps.push(`已備份解除安裝前的設定到 ${backup}`)
    writeJsonAtomic(paths.claudeSettings, removeHelmHook(settings))
    steps.push(`已從 ${paths.claudeSettings} 移除 hook`)
  }

  const swiftbar = deps.swiftbar ?? defaultSwiftBarDeps()
  const ubersicht = deps.ubersicht ?? defaultUbersichtDeps()
  const pluginDir = resolvePluginDir(paths, swiftbar)
  const widgetDir = resolveWidgetDir(paths, ubersicht)
  // Uninstall must reach every folder helm might have written into, so an
  // unreadable preference falls back to the default here rather than giving
  // up — leaving a live plugin behind is the one thing it must never do.
  for (const path of [
    wrapperPath(paths),
    join(pluginDir.dir ?? defaultPluginDir(paths), PLUGIN_NAME),
    // The pre-rename default, so an install from before this moved still
    // gets cleaned up rather than left running.
    join(paths.home, 'Library', 'Application Support', 'SwiftBar', PLUGIN_NAME),
    join(widgetDir.dir ?? defaultWidgetDir(paths), WIDGET_NAME),
  ]) {
    if (!isOurScript(path)) continue
    // Written by helm, then edited by the user. Deleting it would throw away
    // work helm's own file header invited them to do.
    if (!isUnmodified(path)) {
      warnings.push(`${path} 你改過了，保留未刪。不需要的話請自行刪除。`)
      continue
    }
    rmSync(path, { force: true })
    steps.push(`已移除 ${path}`)
  }

  // `adoptable` means the app has no setting at all, so there is nothing to
  // hand back. A setting whose value is helm's own default is one helm wrote;
  // anything else was the user's choice and stays exactly as it is.
  if (!pluginDir.adoptable && pluginDir.dir === defaultPluginDir(paths)) {
    releasePluginDir(swiftbar)
    steps.push('已還原 SwiftBar 的 plugin 資料夾設定（那是 helm 安裝時設的）')
  }
  if (!widgetDir.adoptable && widgetDir.dir === defaultWidgetDir(paths)) {
    releaseWidgetDir(ubersicht)
    steps.push('已還原 Übersicht 的 widget 資料夾設定（那是 helm 安裝時設的）')
  }

  // live/ and cache.json stay. They are the user's own history, and deleting
  // them here would turn "stop collecting" into "throw away what you already
  // collected" — a very different thing to agree to.
  warnings.push(`${paths.helmHome} 底下的 live 檔、快取與備份都保留未動，要清掉請自行刪除。`)
  return { steps, warnings, ok: steps.length > 0 }
}

function wrapperPath(paths: HelmPaths): string {
  return join(paths.home, '.local', 'bin', 'helm')
}

/** Compares resolved paths, so a stray trailing slash is not a false warning. */
function onPath(dir: string): boolean {
  const target = resolve(dir)
  return (process.env['PATH'] ?? '')
    .split(':')
    .filter((p) => p !== '')
    .some((p) => resolve(p) === target)
}

/**
 * Pins the interpreter by absolute path, with PATH as a fallback.
 *
 * SwiftBar, and anything else launched from Finder or a login item, inherits
 * launchd's bare PATH — `/usr/bin:/bin:/usr/sbin:/sbin`. Every Node version
 * manager (volta, nvm, fnm) installs its shim under the home directory, so a
 * bare `node` is simply not found there and the menu bar goes blank after the
 * next reboot with nothing to explain why.
 *
 * The fallback matters too: an absolute path breaks when the version manager
 * upgrades Node and removes the old image. `helm doctor` checks the pinned
 * path still exists so that failure is reported rather than discovered.
 */
function nodeInvocation(nodeBin: string): string {
  return `NODE=${shellQuote(nodeBin)}\n[ -x "$NODE" ] || NODE=node`
}

/** Returns false when something helm did not write already occupies the path. */
function writeOurScript(path: string, body: string): boolean {
  return writeOurFile(path, stamped(`${body}${SCRIPT_MARKER}\n`, '#'), 0o755)
}

function writeOurFile(path: string, body: string, mode: number): boolean {
  // `lstat`, not `existsSync`: the latter follows links, so a dangling symlink
  // looked like "nothing here" and helm wrote *through* it into whatever the
  // link pointed at — reporting the link's path as installed, and later
  // removing only the link and orphaning the file it had created.
  if (isSymlink(path)) return false
  if (existsSync(path) && !isOurScript(path)) return false
  // Written by helm, then edited by the user. Their version stays.
  if (existsSync(path) && !isUnmodified(path)) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  chmodSync(path, mode)
  return true
}

/**
 * Both marker forms are accepted, because helm writes two kinds of file: shell
 * scripts, where the marker is a `#` comment, and an Übersicht widget, which is
 * an ES module where `#` is a syntax error. Requiring the comment prefix — not
 * just the bare word — is what keeps a third-party file that merely mentions
 * helm from being deleted by uninstall.
 */
/** Says which of the three reasons applied, because they need different fixes. */
function refusal(path: string): string {
  if (isSymlink(path)) return refusedSymlink(path)
  if (isOurScript(path)) {
    return `${path} 你改過了，helm 保留你的版本沒有覆寫。`
      + '想換回 helm 產生的版本，把它刪掉再跑一次 helm install。'
  }
  return `${path} 已經存在且不是 helm 寫的，未覆寫。`
}

function refusedSymlink(path: string): string {
  return `${path} 是一個 symlink，helm 不會沿著它寫 —— 那會把檔案放到宣告以外的地方，`
    + '而解除安裝時只刪得掉連結本身。請自行移走它再跑一次 helm install。'
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    // Not there at all, which is the normal case for a fresh install.
    return false
  }
}

function isOurScript(path: string): boolean {
  if (isSymlink(path)) return false
  try {
    const body = readFileSync(path, 'utf8')
    return body.includes(SCRIPT_MARKER) || body.includes(WIDGET_COMMENT)
  } catch {
    // Missing or unreadable: either way it is not a file helm may delete.
    return false
  }
}

/** Distinct from `{}` so the caller can refuse rather than clobber. */
const UNREADABLE = Symbol('unreadable')

function readSettings(file: string): unknown {
  if (!existsSync(file)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Deliberately NOT degrading to an empty object. Everywhere else in helm a
    // failed read degrades to "nothing there", but here "nothing there" would
    // be written back over the user's entire configuration.
    return UNREADABLE
  }
  // Parsing successfully is not the same as understanding. An array, a string
  // or a number would sail past the catch above and then be replaced wholesale
  // by an object — the exact outcome the comment there rules out.
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed
    : UNREADABLE
}

/**
 * settings.json may hold tokens under `env`; a backup of it deserves the same
 * mode, and the same temp-then-rename that the original write gets.
 *
 * A half-written backup carries exactly the same filename format as a good
 * one, so restoring "the earliest backup" after a problem would hand the user
 * truncated JSON — and nothing in helm checks a backup's integrity.
 */
function writeBackup(path: string, body: string): void {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/**
 * Write to a sibling then rename. `writeFileSync` truncates in place, so a
 * crash mid-write would leave the user with a half-written settings.json and
 * a Claude Code that no longer starts cleanly.
 *
 * Three properties of the original are carried across, because rename replaces
 * the inode and would otherwise quietly discard all three:
 *   - the symlink, by resolving it first and writing the real file. Managing
 *     ~/.claude/settings.json from a dotfiles repo is common, and replacing
 *     the link with a plain file severs that for good with no message.
 *   - the mode, so a deliberately 0600 file does not come back 0644.
 *   - the indent, so one install does not rewrite every line of a file the
 *     user keeps in git.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const target = realPathOf(file)
  const indent = indentOf(target)
  const temp = `${target}.${process.pid}.tmp`
  // The mode goes on at creation, not afterwards. settings.json can hold an
  // API token under `env`; writing it 0644 and chmod-ing later leaves a window
  // — at a completely predictable filename — where anything else on the
  // machine can read it. A new file gets 0600 for the same reason.
  const mode = modeOf(target) ?? 0o600
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, indent)}\n`, { encoding: 'utf8', mode })
    // `mode` is masked by umask on creation, so set it explicitly as well.
    chmodSync(temp, mode)
    renameSync(temp, target)
  } catch (err) {
    // Otherwise a full disk leaves a readable copy of the user's tokens lying
    // in ~/.claude for good, and one more with every retry.
    rmSync(temp, { force: true })
    throw err
  }
}

function realPathOf(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    // Not there yet — writing the path as given is exactly right.
    return file
  }
}

function modeOf(file: string): number | null {
  try {
    return statSync(file).mode & 0o777
  } catch {
    // No original to copy from; the default mode is correct for a new file.
    return null
  }
}

/** Detected rather than assumed, from the first indented line. Defaults to 2. */
function indentOf(file: string): number {
  try {
    const match = readFileSync(file, 'utf8').match(/\n([ ]+)\S/)
    return match?.[1]?.length ?? 2
  } catch {
    return 2
  }
}
