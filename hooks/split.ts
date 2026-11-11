// The context split into what every session carries (the fixed part) and the conversation.
// Pure: register.tsx fetches the breakdown when the panel opens and hands the rows here.

/** The part of a `ContextCategory` row this module reads. */
export type CategoryRow = { name: string; tokens: number; kind: string }

// Declared in types/index.d.ts, which must be self-contained, so it is imported from there.
export type { ContextSplit } from '../types'
import type { ContextSplit } from '../types'

/** At most this many fixed sub-parts are listed. */
export const MAX_PARTS = 5
/** Fixed sub-parts under this many tokens are left out of the list (they still count in the total). */
export const MIN_PART_TOKENS = 1000

/**
 * The one place that tells the conversation's row apart by its name: the engine stamps `kind` on
 * every row, but has no kind for Messages, so its label is the only handle.
 */
export function isMessagesRow(row: CategoryRow): boolean {
  return row.name === 'Messages'
}

const LABELS: Array<[RegExp, string]> = [
  [/^system tools?$/i, 'tools'],
  [/^mcp/i, 'MCP'],
  [/^skills?$/i, 'skills'],
  [/^memory/i, 'memory'],
  [/^system prompt$/i, 'system'],
  [/^custom agents?$/i, 'agents'],
  [/^slash commands?$/i, 'commands'],
]

/** A short lowercase label for a fixed row; an unknown name is lowercased as it is. */
export function shortLabel(name: string): string {
  return LABELS.find(([pattern]) => pattern.test(name))?.[1] ?? name.toLowerCase()
}

/**
 * Splits a breakdown's rows. Only `used` rows count: free space, the compaction buffer and deferred
 * tools are not in the window. Returns undefined, so the panel hides the split, when there are no
 * rows or no Messages row to call the conversation.
 */
export function splitContext(rows: readonly CategoryRow[] | undefined): ContextSplit | undefined {
  if (!rows) return undefined
  const used = rows.filter(row => row.kind === 'used')
  const messages = used.find(isMessagesRow)
  if (!messages) return undefined
  const fixedRows = used.filter(row => row !== messages)
  const parts = fixedRows
    .filter(row => row.tokens >= MIN_PART_TOKENS)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_PARTS)
    .map(row => ({ label: shortLabel(row.name), tokens: row.tokens }))
  return { fixed: fixedRows.reduce((sum, row) => sum + row.tokens, 0), conversation: messages.tokens, parts }
}
