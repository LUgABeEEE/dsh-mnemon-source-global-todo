/**
 * The Source itself: read `dsh-global-todo`'s JSON file and hand mnemon a bounded, read-only view
 * of what is still open.
 *
 * Three properties this file is careful about:
 *
 *  - **It never writes.** A todo list is one file that two writers already guard with a lock; a
 *    memory Source is not a third writer, and a source that mutated the list could not honour
 *    `review` (an agent's own completion waits for a person).
 *  - **It reads at request time, per scope.** The store is a human-editable file; caching it would
 *    show yesterday's list. `facts` and `project` share one snapshot per request scope, like the
 *    external-source example in mnemon's documentation.
 *  - **Nothing here is fatal.** A missing or unreadable file is an empty projection, not a
 *    thrown error: mnemon turns a failing Source into a diagnostic on every turn, and a list
 *    nobody has created yet is not a fault.
 *
 * @module dsh-mnemon-source-global-todo/source
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import { COMPOSABLE_MEMORY_API_VERSION } from 'dsh-mnemon/contracts'
import { defineMemorySource, truncateMemoryText } from 'dsh-mnemon/extension-sdk'

/** Parsed documents by absolute path, keyed by the file's `mtimeMs:size` stamp. */
const fileCache = new Map()

export const TYPE_ID = 'global-todo'
export const ROLE = 'actions'
export const CAPABILITIES = ['status', 'project', 'search']

const PRIORITY_LABELS = { urgent: '紧急', high: '高', normal: '普通', low: '低' }

/**
 * Where the list lives. Same rule as the plugin: an explicit path wins, otherwise
 * `$DSH_HOME/global-todo/todos.json`.
 *
 * @param {string} [configured]
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} absolute path
 */
export function resolveStorePath(configured, env = process.env) {
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  if (trimmed !== '') return path.resolve(trimmed)
  const home =
    typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
      ? env.DSH_HOME.trim()
      : path.join(homedir(), '.dsh')
  return path.join(home, 'global-todo', 'todos.json')
}

/**
 * Read the list. Returns an empty document instead of throwing when the file is absent or
 * unreadable — see the module comment.
 *
 * @param {string} file
 * @returns {{ todos: object[], revision: string, readable: boolean }}
 */
export function readStore(file) {
  let info
  try {
    info = statSync(file)
  } catch {
    return { todos: [], revision: 'missing', readable: false }
  }
  // Parsing 1.5 MB on every turn, synchronously, in the host's event loop is what a cache like
  // this is for: the projection runs once per turn even when nothing changed. The stamp is the
  // same `mtimeMs:size` fingerprint the todo plugin itself uses; a write that lands inside the
  // same millisecond *and* keeps the byte count would go unseen, which is the price of not
  // hashing 1.5 MB instead.
  const stamp = `${info.mtimeMs}:${info.size}`
  const cached = fileCache.get(file)
  if (cached !== undefined && cached.stamp === stamp) return cached.value
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { todos: [], revision: 'missing', readable: false }
  }
  const revision = createHash('sha256')
    .update(`${info.mtimeMs}:${info.size}:${text}`)
    .digest('hex')
    .slice(0, 32)
  let document = null
  try {
    document = JSON.parse(text)
  } catch {
    // A corrupt file is reported as readable-but-empty: the plugin itself refuses to write over
    // it, and a memory Source must not be the thing that pretends to understand it.
    return { todos: [], revision: `${revision}:corrupt`, readable: true }
  }
  const raw = document !== null && typeof document === 'object' && Array.isArray(document.todos) ? document.todos : []
  const todos = raw.filter((todo) => todo !== null && typeof todo === 'object' && typeof todo.title === 'string')
  const value = { todos, revision, readable: true }
  fileCache.set(file, { stamp, value })
  return value
}

/**
 * Is this record waiting in the inbox rather than on the list?
 *
 * Read from the tag, because that is what the plugin itself uses; inboxReason is a newer field
 * and a store written by 0.21.0 does not have it.
 *
 * @param {object} todo
 * @returns {boolean}
 */
function isWaiting(todo) {
  const tags = Array.isArray(todo.tags) ? todo.tags : []
  return tags.some((tag) => String(tag).toLowerCase() === 'inbox')
}
/** @param {number} at @param {number} now */
function daysOverdue(at, now) {
  const late = now - at
  return Math.max(1, Math.ceil(late / 86_400_000))
}

/**
 * The open items, most urgent first: overdue, then by deadline, then by priority, then newest.
 *
 * @param {object[]} todos
 * @param {number} now
 * @returns {object[]}
 */
export function openItems(todos, now = Date.now()) {
  const rank = { urgent: 0, high: 1, normal: 2, low: 3 }
  return todos
    // The inbox is where a record waits for a person's decision, not work that is on the list
    // (dsh-global-todo 0.22.0). Projecting it would offer recall the unconfirmed pile: the same
    // noise the gate removed from the panel, arriving through another door.
    .filter((todo) => !isWaiting(todo))
    .filter((todo) => todo.status === 'open' || todo.status === 'doing')
    .map((todo) => {
      const due = typeof todo.dueAt === 'string' ? Date.parse(todo.dueAt) : Number.NaN
      return { todo, due, overdue: Number.isFinite(due) && due < now }
    })
    .sort((left, right) => {
      if (left.overdue !== right.overdue) return left.overdue ? -1 : 1
      const leftDue = Number.isFinite(left.due) ? left.due : Number.POSITIVE_INFINITY
      const rightDue = Number.isFinite(right.due) ? right.due : Number.POSITIVE_INFINITY
      if (leftDue !== rightDue) return leftDue - rightDue
      const byPriority = (rank[left.todo.priority] ?? 2) - (rank[right.todo.priority] ?? 2)
      if (byPriority !== 0) return byPriority
      return (right.todo.createdAt ?? 0) - (left.todo.createdAt ?? 0)
    })
    .map((entry) => ({ ...entry, iso: Number.isFinite(entry.due) ? new Date(entry.due).toISOString().slice(0, 10) : '' }))
}

/**
 * One line per item, the form both the projection and the search route use.
 *
 * @param {{ todo: object, overdue: boolean, iso: string }} entry
 * @param {number} now
 * @param {number} titleLimit
 * @returns {string}
 */
export function itemLine(entry, now, titleLimit = 80, today = Date.now()) {
  const parts = []
  if (entry.overdue) parts.push(`逾期 ${daysOverdue(entry.due, now)} 天`)
  else if (entry.iso !== '') parts.push(`截止 ${entry.iso}`)
  const priority = PRIORITY_LABELS[entry.todo.priority]
  if (priority !== undefined && entry.todo.priority !== 'normal') parts.push(`优先级 ${priority}`)
  const tags = Array.isArray(entry.todo.tags) ? entry.todo.tags.slice(0, 3) : []
  if (tags.length > 0) parts.push(tags.map((tag) => `#${tag}`).join(' '))
  const title = truncateMemoryText(entry.todo.title, titleLimit)
  return parts.length === 0 ? `- ${title}` : `- ${title} · ${parts.join(' · ')}`
}

/**
 * Build the Source definition. The factory is called once per installed instance.
 *
 * @param {{ storePath?: string, projectLimit?: number, titleLimit?: number, searchLimit?: number }} [config]
 */
export function createGlobalTodoSource(config = {}) {
  const file = resolveStorePath(config.storePath)
  const projectLimit = Number.isInteger(config.projectLimit) && config.projectLimit >= 0 ? config.projectLimit : 5
  const titleLimit = Number.isInteger(config.titleLimit) && config.titleLimit > 0 ? config.titleLimit : 80
  const searchLimit = Number.isInteger(config.searchLimit) && config.searchLimit > 0 ? config.searchLimit : 20

  return defineMemorySource({
    manifest: {
      apiVersion: COMPOSABLE_MEMORY_API_VERSION,
      kind: 'source',
      typeId: TYPE_ID,
      packageName: 'dsh-mnemon-source-global-todo',
      role: ROLE,
      capabilities: CAPABILITIES,
      consistency: 'exact-snapshot',
      routes: [
        {
          id: 'search',
          description: 'Search the open items of the global todo list.',
          capability: 'search',
          inputSchema: {
            type: 'object',
            required: ['query'],
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              limit: { type: 'integer' },
            },
          },
          maxCalls: 4,
          maxResults: searchLimit,
          maxCharacters: 8_000,
        },
      ],
      management: {
        label: 'Global todos',
        description: 'The open items of dsh-global-todo, read-only.',
      },
    },

    create(context) {
      /** One snapshot per request scope, so `project` sees exactly what `facts` announced. */
      const snapshots = new WeakMap()

      const snapshot = (scope) => {
        const captured = readStore(file)
        const now = Date.now()
        const items = openItems(captured.todos, now)
        const value = { revision: captured.revision, now, items, readable: captured.readable }
        snapshots.set(scope, value)
        return value
      }

      return {
        facts(request) {
          const current = snapshot(request.scope)
          return {
            sourceInstanceKey: context.sourceInstanceKey,
            sourceTypeId: TYPE_ID,
            role: ROLE,
            availability: current.readable ? 'ready' : 'unavailable',
            revision: current.revision,
            capabilities: CAPABILITIES,
            routeIds: ['search'],
            actionIds: [],
          }
        },

        project(request) {
          const current = snapshots.get(request.scope) ?? snapshot(request.scope)
          snapshots.delete(request.scope)
          if (current.revision !== request.expectedRevision) {
            // The list changed between facts and projection. Saying so is better than rendering
            // a list the View did not announce a revision for.
            throw new Error('global-todo revision changed during composition')
          }
          const shown = projectLimit === 0 ? [] : current.items.slice(0, projectLimit)
          const overdue = current.items.filter((entry) => entry.overdue).length
          const header = `全局待办：未完成 ${current.items.length} 条${overdue > 0 ? `，逾期 ${overdue} 条` : ''}`
          const body = shown.map((entry) => itemLine(entry, current.now, titleLimit)).join('\n')
          const text = body === '' ? header : `${header}\n${body}`
          const fragments = request.includeProjection
            ? [
                {
                  id: `${context.sourceInstanceKey}/projection`,
                  sourceInstanceKey: context.sourceInstanceKey,
                  mode: request.mode,
                  text: truncateMemoryText(text, request.maxCharacters),
                  revision: current.revision,
                  provenance: { sourceTypeId: TYPE_ID },
                },
              ]
            : []
          return {
            fragments,
            presentation: {
              visibleItems: shown.length,
              totalItems: current.items.length,
              items: shown.map((entry) => ({
                id: entry.todo.id,
                title: truncateMemoryText(entry.todo.title, 160),
              })),
            },
            readGrant: {
              id: `${context.sourceInstanceKey}/open-items`,
              sourceInstanceKey: context.sourceInstanceKey,
              schema: 'global-todo/v1',
              consistency: 'exact-snapshot',
              revision: current.revision,
              value: {
                now: current.now,
                items: current.items.map((entry) => ({
                  id: entry.todo.id,
                  title: entry.todo.title,
                  titleLimit,
                  line: itemLine(entry, current.now, titleLimit),
                  overdue: entry.overdue,
                  dueAt: Number.isFinite(entry.due) ? new Date(entry.due).toISOString() : null,
                  priority: entry.todo.priority ?? 'normal',
                  status: entry.todo.status,
                  tags: Array.isArray(entry.todo.tags) ? entry.todo.tags.slice(0, 20) : [],
                })),
              },
            },
          }
        },

        query(request) {
          const grant = request.grant
          const input = request.input ?? {}
          const needle = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''
          const wanted = Number.isInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, searchLimit) : 8
          const items = Array.isArray(grant?.value?.items) ? grant.value.items : []
          const pool = needle === '' ? items : items.filter((item) => {
            const haystack = [item.title, item.priority, item.status, ...(item.tags ?? [])]
              .join(' ')
              .toLowerCase()
            return haystack.includes(needle)
          })
          const matched = pool.slice(0, wanted)
          return {
            id: `${context.sourceInstanceKey}/search`,
            viewId: request.view.id,
            routeId: request.route.id,
            sourceInstanceKey: context.sourceInstanceKey,
            observedAt: new Date().toISOString(),
            // The count before the slice: a caller needs to know an answer was cut, and the
            // slice is what it would otherwise be measuring.
            truncated: pool.length > wanted,
            items: matched.map((item) => ({
              id: item.id,
              text: item.line,
              revision: grant?.revision ?? 'unknown',
              provenance: { source: context.sourceInstanceKey, typeId: TYPE_ID },
            })),
          }
        },
      }
    },
  })
}
