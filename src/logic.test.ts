import { assert, test } from 'orca/testing'
import {
  firstAbsolute,
  fitEntries,
  iconOf,
  localWorktrees,
  originalTitle,
  titleMarkerFor,
  withTitleMarker,
  parseLsof,
  parseServices,
  portOf,
  sameRecord,
  statusItemsFor,
  worktreeFor
} from './logic'

const services = parseServices('🗄️ backend=8080\n# comment\n\n🖥️ frontend=8000\nbad\nx=99999')
const [be, fe] = services
const stack = '🛠️ stack'
const a = { id: 'id-a', path: '/w/a', name: 'a', title: 'a' }
const ab = { id: 'id-ab', path: '/w/a/b', name: 'ab', title: 'ab' }

test('parses label=port lines and skips the rest', () => {
  assert.deepEqual(services, [
    { label: '🗄️ backend', port: 8080 },
    { label: '🖥️ frontend', port: 8000 }
  ])
})

test('parses lsof field output', () => {
  assert.deepEqual(parseLsof('p12\ncnode\nu501\nf31\nn*:8000\nn[::1]:8000\np34\ncmain\nn127.0.0.1:8080\n'), [
    { pid: 12, command: 'node', uid: 501, names: ['*:8000', '[::1]:8000'] },
    { pid: 34, command: 'main', names: ['127.0.0.1:8080'] }
  ])
  assert.equal(portOf('[::1]:8000'), 8000)
  assert.equal(portOf('/some/dir'), undefined)
})

test('maps a directory to the deepest containing worktree', () => {
  assert.equal(worktreeFor('/w/a/b/frontend', [a, ab]), ab)
  assert.equal(worktreeFor('/w/a/c', [a, ab]), a)
  assert.equal(worktreeFor('/w/ax', [a, ab]), undefined)
})

test('builds one status bar item per service', () => {
  const both = statusItemsFor(
    [
      { service: be, owner: { kind: 'worktree', worktree: a } },
      { service: fe, owner: { kind: 'worktree', worktree: a } }
    ],
    stack
  )
  assert.equal(both.length, 1)
  assert.equal(both[0].text, '🛠️ stack: a')
  assert.equal(both[0].workspaceId, 'id-a')

  const split = statusItemsFor(
    [
      { service: be, owner: { kind: 'worktree', worktree: a } },
      { service: fe, owner: { kind: 'worktree', worktree: ab } }
    ],
    stack
  )
  assert.deepEqual(
    split.map((item) => [item.text, item.workspaceId]),
    [
      ['🗄️ backend: a', 'id-a'],
      ['🖥️ frontend: ab', 'id-ab']
    ]
  )

  const partial = statusItemsFor(
    [
      { service: be, owner: { kind: 'other', command: 'ssh' } },
      { service: fe, owner: { kind: 'down' } }
    ],
    stack,
    { downText: 'off', allDownText: 'idle', otherSuffix: '' }
  )
  assert.deepEqual(
    partial.map((item) => [item.text, item.tone, item.workspaceId]),
    [
      ['🗄️ backend: ssh', 'warning', undefined],
      ['🖥️ frontend: off', 'neutral', undefined]
    ]
  )

  const down = statusItemsFor([{ service: fe, owner: { kind: 'down' } }], stack)
  assert.deepEqual(down.map((item) => item.text), ['stack down'])
})

test('shortens the longest names to fit the status bar', () => {
  const entries = [
    { label: '🗄️ backend', name: 'billing-api-rate-limits' },
    { label: '🖥️ frontend', name: 'checkout-redesign-mobile' }
  ]
  const text = fitEntries(entries, ' · ')
  assert.ok(text.length <= 64, `${text.length}: ${text}`)
  assert.match(text, /^🗄️ backend: billing-.*… · 🖥️ frontend: checkout-.*…?$/)
  assert.equal(fitEntries([{ label: 'fe', name: 'short' }], ' · '), 'fe: short')
  assert.equal(fitEntries([{ label: 'x'.repeat(80), name: 'n' }], ' · ').length, 64)
})

test('marks titles with service icons and restores them', () => {
  assert.equal(iconOf('🖥️ frontend'), '🖥️')
  assert.equal(iconOf('frontend'), '')
  assert.equal(iconOf('🛠️ stack'), '🛠️')
  assert.equal(titleMarkerFor([fe], services, stack), '\u{1F5A5}')
  assert.equal(titleMarkerFor([be, fe], services, stack), '\u{1F6E0}')
  assert.equal(titleMarkerFor([be, fe], services, ''), '\u{1F5C4}\u{1F5A5}')
  assert.equal(titleMarkerFor([], services, stack), '')
  assert.equal(withTitleMarker('🖥️', 'Checkout redesign'), '🖥️ Checkout redesign')
})

test('recovers the original title', () => {
  const recorded = 'Checkout redesign'
  assert.equal(originalTitle('🖥 Checkout redesign', recorded), recorded)
  assert.equal(originalTitle('Checkout redesign', recorded), recorded)
  // An interrupted rename can leave a marker the record does not name.
  assert.equal(originalTitle('🛠 Checkout redesign', recorded), recorded)
  // A rename by hand wins, with or without an icon.
  assert.equal(originalTitle('Renamed by hand', recorded), 'Renamed by hand')
  assert.equal(originalTitle('🖥 Renamed by hand', recorded), 'Renamed by hand')
  // A title the plugin never marked keeps its own emoji.
  assert.equal(originalTitle('🚀 Launch', undefined), '🚀 Launch')
  assert.equal(originalTitle('🖥 🚀 Launch', '🚀 Launch'), '🚀 Launch')
  assert.equal(originalTitle('🚀 Launch', '🚀 Launch'), '🚀 Launch')
})

test('compares marker records by content', () => {
  assert.ok(sameRecord({ '/w/a': '🖥️', '/w/b': '🗄️' }, { '/w/b': '🗄️', '/w/a': '🖥️' }))
  assert.ok(!sameRecord({ '/w/a': '🖥️' }, { '/w/a': '🗄️' }))
  assert.ok(!sameRecord({ '/w/a': '🖥️' }, {}))
  assert.ok(!sameRecord({}, { '/w/a': '🖥️' }))
})

test('finds a tool by absolute path only', () => {
  const exists = (path: string) => path === '/usr/bin/lsof' || path === 'lsof'
  assert.equal(firstAbsolute(['/usr/sbin/lsof', '/usr/bin/lsof'], exists), '/usr/bin/lsof')
  assert.equal(firstAbsolute(['lsof'], exists), undefined)
  assert.equal(firstAbsolute(['/usr/sbin/lsof'], exists), undefined)
})

test('keeps one local workspace per path and recovers its title', () => {
  const workspaces = [
    { id: 'id-a', kind: 'worktree' as const, path: '/w/a', name: '🖥 a', hostId: 'local' },
    { id: 'id-b', kind: 'worktree' as const, path: '/w/b', name: 'b', hostId: null },
    { id: 'id-r', kind: 'worktree' as const, path: '/w/r', name: 'r', hostId: 'ssh-box' },
    { id: 'id-f', kind: 'folder' as const, path: '/w/f', name: 'f', hostId: 'local' },
    { id: 'id-f2', kind: 'folder' as const, path: '/w/b', name: 'b folder', hostId: 'local' },
    { id: 'id-a2', kind: 'worktree' as const, path: '/w/a', name: 'a again', hostId: 'local' }
  ]
  assert.deepEqual(localWorktrees(workspaces, { 'id-a': 'a' }), [
    { id: 'id-a', path: '/w/a', title: '🖥 a', name: 'a' },
    { id: 'id-b', path: '/w/b', title: 'b', name: 'b' },
    { id: 'id-f', path: '/w/f', title: 'f', name: 'f' }
  ])
  const folderFirst = [workspaces[4], workspaces[1]]
  assert.deepEqual(localWorktrees(folderFirst, {}).map((w) => w.id), ['id-b'])
})
