import { expect, test } from 'claude-code/testing'

import { MIN, makePlan, priceOf } from './model.ts'
import { panelRows } from './panel.ts'
import { isMessagesRow, shortLabel, splitContext } from './split.ts'

const row = (name: string, tokens: number, kind = 'used') => ({ name, tokens, kind })
// Worked example: fixed = 14+11+6+4+3 = 38k, conversation 82k.
const ROWS = [
  row('System prompt', 3_000),
  row('System tools', 14_000),
  row('MCP tools', 11_000),
  row('Skills', 6_000),
  row('Memory files', 4_000),
  row('Messages', 82_000),
  row('Free space', 700_000, 'free'),
  row('Autocompact buffer', 33_000, 'buffer'),
  row('MCP tools (deferred)', 20_000, 'deferred'),
]

test('the split: used rows only, Messages is the conversation, the rest is fixed, largest first', () => {
  expect(splitContext(ROWS)).toEqual({
    fixed: 38_000,
    conversation: 82_000,
    parts: [
      { label: 'tools', tokens: 14_000 },
      { label: 'MCP', tokens: 11_000 },
      { label: 'skills', tokens: 6_000 },
      { label: 'memory', tokens: 4_000 },
      { label: 'system', tokens: 3_000 },
    ],
  })
})

test('only the five largest fixed parts are listed, tiny and zero ones dropped, all still counted', () => {
  const six = splitContext([row('System prompt', 3_000), row('System tools', 14_000), row('MCP tools', 11_000), row('Skills', 6_000), row('Memory files', 4_000), row('Custom agents', 2_000), row('Messages', 10_000)])
  expect(six?.parts.map(part => part.label)).toEqual(['tools', 'MCP', 'skills', 'memory', 'system'])
  expect(six?.fixed).toBe(40_000)
  const small = splitContext([row('System prompt', 3_000), row('Slash commands', 999), row('Other', 0), row('Messages', 1)])
  expect(small?.parts).toEqual([{ label: 'system', tokens: 3_000 }])
  expect(small?.fixed).toBe(3_999)
})

test('no breakdown, or no Messages row, means no split', () => {
  expect(splitContext(undefined)).toBeUndefined()
  expect(splitContext([])).toBeUndefined()
  expect(splitContext([row('System prompt', 3_000), row('Free space', 9, 'free')])).toBeUndefined()
  // A Messages row that is not in use does not count as the conversation.
  expect(splitContext([row('System prompt', 3_000), row('Messages', 5, 'deferred')])).toBeUndefined()
})

test('the Messages row is told apart by name in one place; labels are shortened, unknown ones lowercased', () => {
  expect(isMessagesRow(row('Messages', 1))).toBe(true)
  expect(isMessagesRow(row('System prompt', 1))).toBe(false)
  expect(shortLabel('Custom agents')).toBe('agents')
  expect(shortLabel('Something new')).toBe('something new')
})

const OPUS = priceOf('claude-opus-5-5')
const text = (rows: { text: string }[][]) => rows.map(each => each.map(piece => piece.text).join('')).join('\n')
const panel = (narrow: boolean, withSplit: boolean) =>
  text(
    panelRows({
      price: OPUS,
      basis: 'api',
      ctx: 120_000,
      leftMs: 42 * MIN,
      plan: makePlan({ ctx: 120_000, price: OPUS, basis: 'api', hours: 4, lastReq: 1_000_000, now: 1_000_000, isWarm: true }),
      isCompactAhead: false,
      isSmall: false,
      narrow,
      split: withSplit ? splitContext(ROWS) : undefined,
    }),
  )

test('the panel lists the fixed part with its sub-parts, then the conversation, under the model line', () => {
  expect(panel(false, true)).toContain('opus-5-5 · 120k tokens\nfixed ~38k (tools 14k · MCP 11k · skills 6k · memory 4k · system 3k)\nconversation ~82k\n')
})

test('narrow: the sub-part list is dropped, the two totals stay', () => {
  const shown = panel(true, true)
  expect(shown).toContain('opus-5-5 · 120k tokens\nfixed ~38k\nconversation ~82k\n')
  expect(shown).not.toContain('tools 14k')
})

test('without a split the panel is unchanged', () => {
  const shown = panel(false, false)
  expect(shown).not.toContain('fixed')
  expect(shown).not.toContain('conversation')
  expect(shown).toContain('opus-5-5 · 120k tokens\n\nNext message')
})
