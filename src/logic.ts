// Pure parts of the worker: config parsing, lsof parsing, owner resolution, title markers, status items.

export type Service = { label: string; port: number }
/** `title` is the display name as Orca shows it; `name` is the title without this plugin's marker. */
export type Worktree = { id: string; path: string; name: string; title: string }
export type Owner = { kind: 'worktree'; worktree: Worktree } | { kind: 'other'; command: string } | { kind: 'down' }
export type Ownership = { service: Service; owner: Owner }

/** At most this many services, one status bar slot each; the manifest declares as many. */
export const STATUS_SLOTS = 6
const MAX_SERVICES = STATUS_SLOTS

/** One service per line, `label=port`. Blank lines and `#` lines are skipped. */
export function parseServices(text: string): Service[] {
  const services: Service[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.lastIndexOf('=')
    if (at <= 0) continue
    const label = line.slice(0, at).trim()
    const port = Number(line.slice(at + 1).trim())
    if (label === '' || !Number.isInteger(port) || port < 1 || port > 65535) continue
    services.push({ label, port })
  }
  return services.slice(0, MAX_SERVICES)
}

export type LsofProcess = { pid: number; command: string; uid?: number; names: string[] }

/** `lsof -F pcun` output: `p<pid>`, `c<command>`, `u<uid>`, `n<name>` records. */
export function parseLsof(output: string): LsofProcess[] {
  const procs: LsofProcess[] = []
  let current: LsofProcess | undefined
  for (const line of output.split('\n')) {
    const field = line[0]
    const value = line.slice(1)
    if (field === 'p') {
      current = { pid: Number(value), command: '', names: [] }
      procs.push(current)
    } else if (current !== undefined && field === 'c') {
      current.command = value
    } else if (current !== undefined && field === 'u') {
      current.uid = Number(value)
    } else if (current !== undefined && field === 'n') {
      current.names.push(value)
    }
  }
  return procs
}

/** The port at the end of an lsof address such as `*:8000` or `[::1]:8000`. */
export function portOf(address: string): number | undefined {
  const match = /:(\d+)$/.exec(address)
  return match === null ? undefined : Number(match[1])
}

/** The worktree with the longest path that contains `dir`. */
export function worktreeFor(dir: string, worktrees: Worktree[]): Worktree | undefined {
  let best: Worktree | undefined
  for (const worktree of worktrees) {
    const inside = dir === worktree.path || dir.startsWith(worktree.path + '/')
    if (inside && (best === undefined || worktree.path.length > best.path.length)) best = worktree
  }
  return best
}

/** The leading emoji of a label such as `🖥️ frontend`, or '' when its first word has letters or digits. */
export function iconOf(label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? ''
  return first !== '' && !/[\p{L}\p{N}]/u.test(first) ? first : ''
}

/**
 * The title marker: the stack label's icon when one worktree runs every service, else each owned
 * service's icon. `workspace.rename` refuses the emoji variation selector U+FE0F, so the marker
 * leaves it out.
 */
export function titleMarkerFor(owned: Service[], services: Service[], stackLabel: string): string {
  if (owned.length === 0) return ''
  const marker =
    stackLabel !== '' && services.length > 1 && owned.length === services.length
      ? iconOf(stackLabel) || stackLabel
      : services
          .filter((s) => owned.includes(s))
          .map((s) => iconOf(s.label) || s.label)
          .join('')
  return marker.replace(/\uFE0F/g, '')
}

/**
 * The title without this plugin's marker. `recorded` is the title the plugin saved before it first
 * marked the workspace; without it the title has no marker. A leading icon word goes, so a title
 * with two markers after an interrupted rename also comes back clean.
 */
export function originalTitle(title: string, recorded: string | undefined): string {
  if (recorded === undefined || title === recorded) return title
  const space = title.indexOf(' ')
  return space > 0 && iconOf(title.slice(0, space)) !== '' ? title.slice(space + 1) : title
}

/** The first candidate that is an absolute path and exists. A bare name would search PATH. */
export function firstAbsolute(candidates: string[], exists: (path: string) => boolean): string | undefined {
  return candidates.find((path) => path.startsWith('/') && exists(path))
}

export function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
}

export function withTitleMarker(marker: string, name: string): string {
  return marker === '' ? name : `${marker} ${name}`
}

export type StatusTexts = { downText: string; allDownText: string; otherSuffix: string }

export const DEFAULT_TEXTS: StatusTexts = {
  downText: 'down',
  allDownText: 'stack down',
  otherSuffix: '(outside Orca)'
}

export function ownerName(owner: Owner, texts: StatusTexts = DEFAULT_TEXTS): string {
  if (owner.kind === 'worktree') return owner.worktree.name
  if (owner.kind === 'other') return `${owner.command} ${texts.otherSuffix}`.trim()
  return texts.downText
}

/** Orca refuses status bar text longer than this, counted in UTF-16 units. */
export const STATUS_TEXT_MAX = 64

/** Joins `label: name` entries, shortening the longest names with an ellipsis until they fit. */
export function fitEntries(entries: { label: string; name: string }[], separator: string, max = STATUS_TEXT_MAX): string {
  const names = entries.map((e) => e.name)
  const render = () => entries.map((e, i) => `${e.label}: ${names[i]}`).join(separator)
  let text = render()
  while (text.length > max) {
    let longest = 0
    for (let i = 1; i < names.length; i++) if (names[i].length > names[longest].length) longest = i
    const name = names[longest]
    const body = name.endsWith('…') ? name.slice(0, -1) : name
    if (body.length <= 1) return text.slice(0, max - 1) + '…'
    names[longest] = body.slice(0, -1) + '…'
    text = render()
  }
  return text
}

export type StatusItem = { text: string; tone: 'neutral' | 'success' | 'warning'; tooltip: string; workspaceId?: string }

/**
 * One status bar item per service; pressing it opens `workspaceId`. A worktree that runs every service
 * collapses to one stack item. With every service stopped, one item shows the all-down text.
 */
export function statusItemsFor(ownerships: Ownership[], stackLabel: string, texts: StatusTexts = DEFAULT_TEXTS): StatusItem[] {
  const name = (owner: Owner) => ownerName(owner, texts)
  const detail = ({ service, owner }: Ownership) => `${service.label} (:${service.port}): ${name(owner)}`
  const up = ownerships.filter(({ owner }) => owner.kind !== 'down')
  if (ownerships.length === 0) return []
  if (up.length === 0) {
    return [{ text: texts.allDownText.slice(0, STATUS_TEXT_MAX), tone: 'neutral', tooltip: ownerships.map(detail).join('\n') }]
  }

  const first = ownerships[0].owner
  const oneWorktree =
    first.kind === 'worktree' &&
    ownerships.every(({ owner }) => owner.kind === 'worktree' && owner.worktree.id === first.worktree.id)
  if (oneWorktree && ownerships.length > 1 && stackLabel !== '') {
    return [
      {
        text: fitEntries([{ label: stackLabel, name: first.worktree.name }], ''),
        tone: 'success',
        tooltip: `${ownerships.map(detail).join('\n')}\nPress to open ${first.worktree.name}`,
        workspaceId: first.worktree.id
      }
    ]
  }

  return ownerships.map((ownership) => {
    const { service, owner } = ownership
    const text = fitEntries([{ label: service.label, name: name(owner) }], '')
    if (owner.kind === 'worktree') {
      return { text, tone: 'success', tooltip: `${detail(ownership)}\nPress to open ${owner.worktree.name}`, workspaceId: owner.worktree.id }
    }
    return { text, tone: owner.kind === 'down' ? 'neutral' : 'warning', tooltip: `${detail(ownership)}\nPress to refresh` }
  })
}

/** A workspace as `workspace.list` returns it. */
export type HostWorkspace = { id: string; kind: 'worktree' | 'folder'; path: string; name: string; hostId: string | null }

/**
 * The workspaces on this machine, one per path, each name without this plugin's marker. `lsof`
 * sees only this machine. When workspaces share a path, a worktree wins over a folder, then the
 * first listed wins, so one listener never marks two titles.
 */
export function localWorktrees(workspaces: HostWorkspace[], originals: Record<string, string>): Worktree[] {
  const byPath = new Map<string, HostWorkspace>()
  for (const w of workspaces) {
    if (w.hostId !== null && w.hostId !== 'local') continue
    const seen = byPath.get(w.path)
    if (seen === undefined || (seen.kind === 'folder' && w.kind === 'worktree')) byPath.set(w.path, w)
  }
  return [...byPath.values()].map((w) => ({ id: w.id, path: w.path, title: w.name, name: originalTitle(w.name, originals[w.id]) }))
}
