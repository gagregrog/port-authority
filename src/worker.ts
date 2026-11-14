// Polls the configured ports, finds the worktree each listener runs from, and shows the owners in
// the status bar and, when turned on, as an icon before each owning worktree's title.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  type Ownership,
  type StatusItem,
  type Service,
  type StatusTexts,
  type Worktree,
  DEFAULT_TEXTS,
  firstAbsolute,
  localWorktrees,
  parseLsof,
  parseServices,
  portOf,
  sameRecord,
  statusItemsFor,
  STATUS_SLOTS,
  titleMarkerFor,
  withTitleMarker,
  worktreeFor
} from './logic'

/** Storage key: workspace id → the title the workspace had before the plugin marked it. */
const ORIGINAL_TITLES_KEY = 'originalTitles'
const ICONS = new Set(['layers', 'activity', 'gauge', 'globe', 'rocket', 'zap', 'code', 'terminal', 'database', 'cloud', 'plug', 'flag', 'star', 'branch'])
// An absolute path only, so a program earlier on PATH cannot stand in for lsof.
const LSOF = firstAbsolute(['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'], existsSync)
const MY_UID = process.getuid?.()

type Config = {
  services: Service[]
  stackLabel: string
  markTitles: boolean
  showStatusBar: boolean
  statusIcon: string
  texts: StatusTexts
  intervalMs: number
}

/** Runs lsof. Exit 1 means no match and its output still counts; any other failure throws. */
function runLsof(lsof: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(lsof, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error === null || (error as { code?: unknown }).code === 1) resolve(stdout ?? '')
      else reject(new Error(`lsof failed: ${error.message}`))
    })
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A string setting; empty falls back. */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value !== '' ? value : fallback
}

async function readConfig(orca: OrcaWorkerApi): Promise<Config> {
  const s = await orca.settings.get()
  return {
    services: parseServices(typeof s.services === 'string' ? s.services : ''),
    stackLabel: typeof s.stackLabel === 'string' ? s.stackLabel.trim() : '',
    markTitles: s.markTitles === true,
    showStatusBar: s.showStatusBar !== false,
    statusIcon: typeof s.statusIcon === 'string' && ICONS.has(s.statusIcon) ? s.statusIcon : 'layers',
    texts: {
      downText: text(s.downText, DEFAULT_TEXTS.downText),
      allDownText: text(s.allDownText, DEFAULT_TEXTS.allDownText),
      otherSuffix: typeof s.otherSuffix === 'string' ? s.otherSuffix : DEFAULT_TEXTS.otherSuffix
    },
    intervalMs: Math.max(2, typeof s.intervalSeconds === 'number' ? s.intervalSeconds : 5) * 1000
  }
}

/** A stored string record; entries that are not strings are dropped. */
async function storedRecord(orca: OrcaWorkerApi, key: string): Promise<Record<string, string>> {
  const stored = await orca.storage.get(key)
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const record: Record<string, string> = {}
  for (const [k, v] of Object.entries(stored)) if (typeof v === 'string') record[k] = v
  return record
}

let loggedTruncated = false

async function listWorkspaces(orca: OrcaWorkerApi, originals: Record<string, string>): Promise<Worktree[]> {
  const { workspaces, truncated } = await orca.host.call('workspace.list')
  // A workspace left out of a truncated list shows as outside Orca.
  if (truncated && !loggedTruncated) orca.log('workspace.list is truncated; some workspaces can show as outside Orca')
  loggedTruncated = truncated
  return localWorktrees(workspaces, originals)
}

async function resolveOwners(lsof: string, services: Service[], worktrees: Worktree[]): Promise<Ownership[]> {
  if (services.length === 0) return []
  const listenArgs = ['-nP', '-sTCP:LISTEN', '-Fpcun', ...services.map((s) => `-iTCP:${s.port}`)]
  const pidByPort = new Map<number, { pid: number; command: string; uid?: number }>()
  for (const proc of parseLsof(await runLsof(lsof, listenArgs))) {
    for (const name of proc.names) {
      const port = portOf(name)
      if (port !== undefined && !pidByPort.has(port)) pidByPort.set(port, proc)
    }
  }

  const pids = [...new Set([...pidByPort.values()].map((p) => p.pid))]
  const cwdByPid = new Map<number, string>()
  if (pids.length > 0) {
    for (const proc of parseLsof(await runLsof(lsof, ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]))) {
      if (proc.names[0] !== undefined) cwdByPid.set(proc.pid, proc.names[0])
    }
  }

  return services.map((service): Ownership => {
    const listener = pidByPort.get(service.port)
    if (listener === undefined) return { service, owner: { kind: 'down' } }
    // Another user's process cannot claim a worktree.
    if (listener.uid !== MY_UID) return { service, owner: { kind: 'other', command: listener.command } }
    const cwd = cwdByPid.get(listener.pid)
    const worktree = cwd === undefined ? undefined : worktreeFor(cwd, worktrees)
    if (worktree === undefined) return { service, owner: { kind: 'other', command: listener.command } }
    return { service, owner: { kind: 'worktree', worktree } }
  })
}

function ownedById(ownerships: Ownership[]): Map<string, Service[]> {
  const owned = new Map<string, Service[]>()
  for (const { service, owner } of ownerships) {
    if (owner.kind !== 'worktree') continue
    owned.set(owner.worktree.id, [...(owned.get(owner.worktree.id) ?? []), service])
  }
  return owned
}

/** How long a rename that Orca calls not retryable waits before the next try. */
const RENAME_RETRY_MS = 5 * 60_000

/** The last failed rename per workspace id: the title it tried and when to try it again. */
const failedRenames = new Map<string, { title: string; retryAt: number }>()

/**
 * Puts the owned services' icons before each owning worktree's title and restores the title when
 * it stops owning one. Renaming a workspace fixes its name, as renaming it by hand does.
 *
 * The original title goes to storage before the first rename and leaves only after the restore,
 * so a worker that stops between the two still finds the marker on the next start.
 */
async function markTitles(
  orca: OrcaWorkerApi,
  config: Config,
  worktrees: Worktree[],
  ownerships: Ownership[],
  originals: Record<string, string>
): Promise<void> {
  const owned = ownedById(ownerships)
  const record: Record<string, string> = {}
  const renames: { worktree: Worktree; desired: string }[] = []
  for (const worktree of worktrees) {
    const marker = config.markTitles ? titleMarkerFor(owned.get(worktree.id) ?? [], config.services, config.stackLabel) : ''
    const desired = withTitleMarker(marker, worktree.name)
    if (marker !== '' || (originals[worktree.id] !== undefined && desired !== worktree.title)) record[worktree.id] = worktree.name
    if (desired !== worktree.title) renames.push({ worktree, desired })
  }
  if (!sameRecord(record, originals)) await orca.storage.set(ORIGINAL_TITLES_KEY, record)
  if (renames.length === 0) return

  // A title renamed by hand during this poll is left alone; the next poll sees the new title.
  const current = new Map((await orca.host.call('workspace.list')).workspaces.map((w) => [w.id, w.name]))
  let restored = false
  for (const { worktree, desired } of renames) {
    if (current.get(worktree.id) !== worktree.title) continue
    const failed = failedRenames.get(worktree.id)
    const sameTitle = failed?.title === desired
    if (failed !== undefined && sameTitle && Date.now() < failed.retryAt) continue
    try {
      await orca.host.call('workspace.rename', { workspaceId: worktree.id, name: desired })
      failedRenames.delete(worktree.id)
      if (desired === worktree.name) {
        delete record[worktree.id]
        restored = true
      }
      // The workspace id, not the title: logs get pasted into bug reports.
      orca.log(desired === worktree.name ? `restored the title of ${worktree.id}` : `marked ${worktree.id}`)
    } catch (error) {
      const retryable = (error as { retryable?: unknown }).retryable === true
      failedRenames.set(worktree.id, { title: desired, retryAt: Date.now() + (retryable ? 0 : RENAME_RETRY_MS) })
      if (!sameTitle) {
        const when = retryable ? 'retrying each poll' : 'retrying every 5 minutes'
        orca.log(`rename of ${worktree.id} failed, ${when}: ${messageOf(error)}`)
      }
    }
  }
  if (restored) await orca.storage.set(ORIGINAL_TITLES_KEY, record)
}

async function tick(orca: OrcaWorkerApi): Promise<Config> {
  const config = await readConfig(orca)
  if (LSOF === undefined) {
    await showWarning(orca, config, 'port authority: lsof not found', 'Install lsof in /usr/sbin, /usr/bin, or /bin')
    return config
  }
  const originals = await storedRecord(orca, ORIGINAL_TITLES_KEY)
  let worktrees: Worktree[]
  try {
    worktrees = await listWorkspaces(orca, originals)
  } catch (error) {
    await showWarning(orca, config, 'port authority: cannot list workspaces', messageOf(error))
    return config
  }
  let ownerships: Ownership[]
  try {
    ownerships = await resolveOwners(LSOF, config.services, worktrees)
  } catch (error) {
    // Without a full lsof answer, every service would look stopped.
    await showWarning(orca, config, 'port authority: ports unavailable', messageOf(error))
    return config
  }
  await markTitles(orca, config, worktrees, ownerships, originals)
  await showItems(orca, config, statusItemsFor(ownerships, config.stackLabel, config.texts))
  return config
}

function showWarning(orca: OrcaWorkerApi, config: Config, text: string, reason: string): Promise<void> {
  return showItems(orca, config, [{ text, tone: 'warning', tooltip: `${reason}\nPress to retry` }])
}

/** The workspace each status bar slot opens; a slot without one refreshes. */
const slotWorkspaces: (string | undefined)[] = []

async function showItems(orca: OrcaWorkerApi, config: Config, items: StatusItem[]): Promise<void> {
  for (let slot = 0; slot < STATUS_SLOTS; slot++) {
    const item = config.showStatusBar ? items[slot] : undefined
    slotWorkspaces[slot] = item?.workspaceId
    if (item === undefined) {
      await orca.host.call('statusBar.update', { id: `slot${slot + 1}`, visible: false })
      continue
    }
    const { workspaceId: _workspaceId, ...shown } = item
    await orca.host.call('statusBar.update', {
      id: `slot${slot + 1}`,
      ...shown,
      icon: config.statusIcon as 'layers',
      visible: true
    })
  }
}

async function openSlot(orca: OrcaWorkerApi, slot: number): Promise<string> {
  const workspaceId = slotWorkspaces[slot]
  if (workspaceId === undefined) {
    await tickOnce(orca)
    return 'Port Authority refreshed'
  }
  try {
    await orca.host.call('workspace.open', { workspaceId })
  } catch (error) {
    orca.log(`open ${workspaceId} failed: ${messageOf(error)}`)
    return `Could not open the workspace: ${messageOf(error)}`
  }
  return 'Opened the workspace'
}

let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
let running: Promise<Config> | undefined

/** One tick at a time: a refresh during a tick waits for it. */
function tickOnce(orca: OrcaWorkerApi): Promise<Config> {
  running ??= tick(orca).finally(() => {
    running = undefined
  })
  return running
}

function schedule(orca: OrcaWorkerApi, delayMs: number): void {
  if (stopped) return
  timer = setTimeout(async () => {
    let interval = 5000
    try {
      interval = (await tickOnce(orca)).intervalMs
    } catch (error) {
      orca.log(`tick failed: ${messageOf(error)}`)
    }
    schedule(orca, interval)
  }, delayMs)
}

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  orca.commands.register('port-authority.refresh', async () => {
    await tickOnce(orca)
    return 'Port Authority refreshed'
  })
  for (let slot = 0; slot < STATUS_SLOTS; slot++) {
    orca.commands.register(`port-authority.open${slot + 1}`, () => openSlot(orca, slot))
  }
  orca.settings.onDidChange(() => {
    tickOnce(orca).catch(() => undefined)
  })
  schedule(orca, 0)
}

export function deactivate(): void {
  stopped = true
  if (timer !== undefined) clearTimeout(timer)
}
