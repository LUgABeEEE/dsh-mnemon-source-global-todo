/**
 * The plugin entry: a mnemon Source that publishes dsh-global-todo's open items as read-only
 * context.
 *
 * The shape of this file is a compatibility decision, not a style one. It has NO static import of
 * dsh-mnemon: a bundle row is mounted by the Loader whether or not the memory plugin is installed,
 * and a top-level import of dsh-mnemon/extension-sdk would turn 'the user uninstalled the memory
 * plugin' into a failed entry in their Loader. Imports happen inside apply, which Cordis only calls
 * once mnemonMemory exists (see inject), so:
 *
 *  - mnemon installed  -> apply runs, the SDK resolves, the Source is installed;
 *  - mnemon absent     -> apply is never called, the bundle loads and waits, no error;
 *  - mnemon half-removed (service up, package gone) -> one warning, everything else keeps working.
 *
 * memoryPlugin is plain data for the same reason: mnemon reads a loaded entry's export and wraps it
 * with defineMemoryPlugin itself, so building the descriptor here would only add a dependency to a
 * file that must be importable on its own.
 *
 * @module dsh-mnemon-source-global-todo
 */

export const name = 'dsh-mnemon-source-global-todo'

/**
 * What Cordis waits for. Without it the host never calls apply, which is exactly the behaviour
 * wanted on a machine that does not run a memory plugin.
 */
export const inject = ['mnemonMemory']

/** Read by mnemon's plugin catalog; JSON-safe, no functions. */
export const memoryPlugin = {
  packageName: name,
  label: { en: 'Global todos', 'zh-CN': '全局待办' },
  description: {
    en: 'The open items of dsh-global-todo, read-only, so a View can show them without a tool call first.',
    'zh-CN': '只读暴露全局待办里未完成/逾期的条目，让 View 不必先调工具就能看到。',
  },
  roles: ['source'],
  provides: [{ id: 'source' }],
}

/**
 * Install the Source into the running memory service.
 *
 * @param {object} ctx - Cordis context, carrying mnemonMemory and logger
 * @param {{ storePath?: string, projectLimit?: number, titleLimit?: number, searchLimit?: number }} [config]
 */
export async function apply(ctx, config = {}) {
  try {
    const sdk = await import('dsh-mnemon/extension-sdk')
    const { createGlobalTodoSource } = await import('./source.js')
    sdk.installMemory(
      ctx,
      { plugin: sdk.defineMemoryPlugin(memoryPlugin), sources: [createGlobalTodoSource(config)] },
      { effectiveDigest: sdk.memoryConfigurationDigest(config) },
    )
  } catch (error) {
    // The service was there a moment ago but its package is not resolvable: a half-finished
    // uninstall. Say it once and leave the rest of the host alone - a source nobody can read must
    // not be the reason a conversation fails to start.
    const detail = error?.message ?? String(error)
    ctx?.logger?.warn?.('dsh-mnemon-source-global-todo: 没有加载（没装 dsh-mnemon 时这是正常的）：' + detail)
  }
}
