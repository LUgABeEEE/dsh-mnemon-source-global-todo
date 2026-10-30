import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  CAPABILITIES,
  TYPE_ID,
  createGlobalTodoSource,
  itemLine,
  openItems,
  readStore,
  resolveStorePath,
} from '../lib/source.js'

/**
 * What these pin: the projection is bounded and ordered, the search route answers from the
 * snapshot the View was granted, and a missing or corrupt file is an empty list rather than an
 * error on every turn. Nothing here writes: a memory Source is not a third writer of the store.
 */

const NOW = Date.parse('2026-10-27T12:00:00+08:00')

function todo(over = {}) {
  return {
    id: 't-' + Math.random().toString(16).slice(2, 10),
    title: '一件要做的事',
    status: 'open',
    priority: 'normal',
    createdAt: NOW - 86_400_000,
    links: [],
    tags: [],
    steps: [],
    activity: [],
    ...over,
  }
}

async function space(contents) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-source-'))
  const file = path.join(dir, 'todos.json')
  if (contents !== undefined) {
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify({ version: 1, todos: contents }))
  }
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A refrigerator: the Source only needs the scope object as a snapshot key. */
function scope() {
  return { workspaceId: 'w' }
}

function definition(file, config = {}) {
  return createGlobalTodoSource({ storePath: file, ...config })
}

/** facts → project for one scope, the way the runner does it. */
function compose(source, scoped = scope()) {
  const instance = source.create({ sourceInstanceKey: 'source:test', configuration: {} })
  const facts = instance.facts({ scope: scoped, scenario: 'turn' })
  const projected = instance.project({
    scope: scoped,
    includeProjection: true,
    mode: 'turn',
    maxCharacters: 4_000,
    expectedRevision: facts.revision,
  })
  return { instance, facts, projected }
}

test('the configured path wins, otherwise $DSH_HOME/global-todo/todos.json', () => {
  assert.equal(resolveStorePath('/notes/list.json', { DSH_HOME: '/home/me/.dsh' }), path.resolve('/notes/list.json'))
  assert.equal(resolveStorePath('', { DSH_HOME: '/home/me/.dsh' }), path.join('/home/me/.dsh', 'global-todo', 'todos.json'))
  assert.equal(resolveStorePath(undefined, { DSH_HOME: '' }), path.join(process.env.HOME ?? '', '.dsh', 'global-todo', 'todos.json'))
})

test('a missing file is an empty, unavailable source, not an error', async () => {
  const s = await space()
  try {
    const definitionOne = definition(s.file)
    const { facts } = compose(definitionOne)
    assert.equal(facts.availability, 'unavailable')
    assert.equal(facts.routeIds.length, 1)
    const read = readStore(s.file)
    assert.deepEqual(read.todos, [])
    assert.equal(read.readable, false)
  } finally {
    await s.cleanup()
  }
})

test('a corrupt file reads as an empty list and says so in the revision', async () => {
  const s = await space('{ not json')
  try {
    const read = readStore(s.file)
    assert.deepEqual(read.todos, [])
    assert.equal(read.readable, true)
    assert.match(read.revision, /:corrupt$/)
  } finally {
    await s.cleanup()
  }
})

test('open items come first, overdue before due before priority', () => {
  const todos = [
    todo({ id: 't-later', title: '远期', dueAt: new Date(NOW + 7 * 86_400_000).toISOString(), priority: 'urgent' }),
    todo({ id: 't-soon', title: '马上到期', dueAt: new Date(NOW + 86_400_000).toISOString() }),
    todo({ id: 't-late', title: '已经逾期', dueAt: new Date(NOW - 2 * 86_400_000).toISOString() }),
    todo({ id: 't-done', title: '已完成', status: 'done' }),
    todo({ id: 't-arch', title: '归档', status: 'archived' }),
    todo({ id: 't-doing', title: '在做', status: 'doing', priority: 'high' }),
  ]
  const items = openItems(todos, NOW).map((entry) => entry.todo.id)
  assert.deepEqual(items.slice(0, 2), ['t-late', 't-soon'])
  assert.ok(items.includes('t-doing'), 'doing is still open work')
  assert.ok(!items.includes('t-done') && !items.includes('t-arch'))
})

test('a line carries the overdue count, the deadline, priority and tags', () => {
  const [entry] = openItems([todo({ title: '修机器', dueAt: new Date(NOW - 3 * 86_400_000).toISOString(), priority: 'high', tags: ['a', 'b'] })], NOW)
  const line = itemLine(entry, NOW, 80)
  assert.match(line, /^- 修机器 · 逾期 3 天 · 优先级 高 · #a #b$/)
  const normal = itemLine(openItems([todo({ title: '普通' })], NOW)[0], NOW, 80)
  assert.equal(normal, '- 普通', 'normal priority and no deadline means no decoration')
})

test('the projection is bounded, counted, and carries a read grant', async () => {
  const s = await space(Array.from({ length: 12 }, (_, index) => todo({ title: '任务 ' + index })))
  try {
    const { projected } = compose(definition(s.file, { projectLimit: 5 }))
    assert.equal(projected.presentation.totalItems, 12)
    assert.equal(projected.presentation.visibleItems, 5)
    assert.equal(projected.fragments.length, 1)
    assert.match(projected.fragments[0].text, /^全局待办：未完成 12 条/)
    assert.equal(projected.fragments[0].text.split('\n').length, 6, 'header plus five items')
    assert.equal(projected.readGrant.value.items.length, 12)
    assert.equal(projected.readGrant.sourceInstanceKey, 'source:test')
  } finally {
    await s.cleanup()
  }
})

test('a revision change between facts and projection is refused, not rendered', async () => {
  const s = await space([todo()])
  try {
    const instance = definition(s.file).create({ sourceInstanceKey: 'source:test', configuration: {} })
    const scoped = scope()
    instance.facts({ scope: scoped, scenario: 'turn' })
    assert.throws(
      () =>
        instance.project({
          scope: scoped,
          includeProjection: true,
          mode: 'turn',
          maxCharacters: 1_000,
          expectedRevision: 'something-else',
        }),
      /revision changed/,
    )
  } finally {
    await s.cleanup()
  }
})

test('the search route answers from the granted snapshot, with a real needle and a limit', async () => {
  const s = await space([
    todo({ title: '清理 docker 镜像', tags: ['docker'] }),
    todo({ title: '写发布说明' }),
    todo({ title: 'docker 自检脚本', tags: ['SER8'] }),
  ])
  try {
    const { instance, projected } = compose(definition(s.file))
    const request = (input) => ({
      view: { id: 'view:test' },
      route: { id: 'search' },
      grant: projected.readGrant,
      input,
    })
    const hits = instance.query(request({ query: 'docker' }))
    assert.equal(hits.items.length, 2)
    assert.ok(hits.items.every((item) => /docker/.test(item.text.toLowerCase())))
    assert.equal(hits.routeId, 'search')
    assert.equal(hits.viewId, 'view:test')
    const limited = instance.query(request({ query: 'docker', limit: 1 }))
    assert.equal(limited.items.length, 1)
    assert.equal(limited.truncated, true)
    const empty = instance.query(request({ query: '', limit: 2 }))
    assert.equal(empty.items.length, 2)
  } finally {
    await s.cleanup()
  }
})

test('the manifest says what this Source is: read-only actions from one file', () => {
  const source = definition('/tmp/never-read.json')
  const manifest = source.manifest
  assert.equal(manifest.kind, 'source')
  assert.equal(manifest.typeId, TYPE_ID)
  assert.equal(manifest.packageName, 'dsh-mnemon-source-global-todo')
  assert.equal(manifest.consistency, 'exact-snapshot')
  assert.deepEqual(manifest.capabilities, CAPABILITIES)
  assert.deepEqual(manifest.routes.map((route) => route.id), ['search'])
  assert.deepEqual(manifest.actions, [], 'no action: this Source never writes')
})

test('a rewrite is picked up: the cache is keyed by the file, not by time', async () => {
  const s = await space([todo({ title: '旧的一条' })])
  try {
    const first = readStore(s.file)
    assert.equal(first.todos.length, 1)
    await writeFile(s.file, JSON.stringify({ version: 1, todos: [todo({ title: '新的一条' }), todo({ title: '又多一条' })] }))
    const second = readStore(s.file)
    assert.notEqual(second.revision, first.revision, 'the stamp moved, so the document was parsed again')
    assert.deepEqual(second.todos.map((entry) => entry.title), ['新的一条', '又多一条'])
  } finally {
    await s.cleanup()
  }
})

test('a record waiting in the inbox is not offered as work', () => {
  // dsh-global-todo 0.22.0 parks unconfirmed agent records in the inbox. Recall must not offer
  // them: a projection that says "here is what is open" while including 69 records nobody has
  // confirmed is the same noise, arriving through a different door.
  const now = Date.parse('2026-10-30T04:00:00Z')
  const todos = [
    { id: 't-list', title: '在清单里', status: 'open', tags: [], createdAt: now },
    { id: 't-inbox', title: '等在收件箱', status: 'open', tags: ['inbox'], inboxReason: 'no-due', createdAt: now },
    { id: 't-done', title: '做完了', status: 'done', tags: [], createdAt: now },
    { id: 't-doing', title: '在做', status: 'doing', tags: [], createdAt: now },
  ]
  const open = openItems(todos, now)
  assert.deepEqual(open.map((entry) => entry.todo.id).sort(), ['t-doing', 't-list'])
  // The filter is on the tag, so a store written before inboxReason existed is handled too.
  const legacy = openItems([{ id: 't-old', title: '旧收件箱', status: 'open', tags: ['Inbox'] }], now)
  assert.deepEqual(legacy, [])
})

