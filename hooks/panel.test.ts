import { expect, test } from 'claude-code/testing'

import { MIN, makePlan, priceOf } from './model.ts'
import { cacheBar, panelRows } from './panel.ts'

const OPUS = priceOf('claude-opus-5-5')
const text = (rows: { text: string }[][]) => rows.map(row => row.map(piece => piece.text).join('')).join('\n')
const plan = (ctx: number, hours: number, isWarm = true) => makePlan({ ctx, price: OPUS, basis: 'api', hours, lastReq: 1_000_000, now: 1_000_000, isWarm })

test('the bar fills with the time left: green, amber in the last ten minutes, red when out', () => {
  expect(cacheBar(30 * MIN).map(piece => piece.text).join('')).toBe('██████████░░░░░░░░░░')
  expect(cacheBar(30 * MIN)[0]?.color).toBe('green')
  expect(cacheBar(8 * MIN)[0]?.color).toBe('yellow')
  expect(cacheBar(-MIN)[0]).toEqual({ text: '', color: 'red' })
})

test('a warm panel: bar, what the next message costs now and once cold, options with the cheapest marked', () => {
  const rows = panelRows({ price: OPUS, basis: 'api', ctx: 120_000, leftMs: 42 * MIN, plan: plan(120_000, 4), isCompactAhead: false, isSmall: false, narrow: false })
  const shown = text(rows)
  expect(shown).toContain('Cache ██████████████░░░░░░ 42m left')
  expect(shown).toContain('Next message now: ~6k $0.02 · once cold: ~240k $0.96')
  expect(shown).toContain('Away for 4h (change the hours below)')
  expect(shown).toMatch(/▸ Keep warm\s+4 pings\s+~24k\s+\$0\.10\s+◂ cheapest/)
  expect(shown).toContain('Keep-warm stays cheaper than compacting')
})

test('above the idle-compaction size keep-warm is out and the advice says why', () => {
  const shown = text(panelRows({ price: OPUS, basis: 'api', ctx: 250_000, leftMs: 20 * MIN, plan: plan(250_000, 4), isCompactAhead: true, isSmall: false, narrow: false }))
  expect(shown).toMatch(/ {2}Keep warm\s+4 pings\s+n\/a/)
  expect(shown).toContain('compacts this conversation itself at minute 54')
})

test('a cold panel says only what the next message rewrites', () => {
  const shown = text(panelRows({ price: OPUS, basis: 'api', ctx: 120_000, leftMs: -5 * MIN, plan: plan(120_000, 4, false), isCompactAhead: false, isSmall: false, narrow: false }))
  expect(shown).toContain('cold for 5m')
  expect(shown).toContain('Next message rewrites the cache: ~240k')
  expect(shown).not.toContain('Away for')
})

test('the README example is what the panel computes for 120k tokens on Opus 5.5, 4h away', () => {
  const shown = text(panelRows({ price: OPUS, basis: 'api', ctx: 120_000, leftMs: 42 * MIN, plan: plan(120_000, 4), isCompactAhead: false, isSmall: false, narrow: false }))
  expect(shown).toMatch(/Compact now\s+~85k\s+\$0\.34/)
  expect(shown).toMatch(/Do nothing\s+~234k\s+\$0\.94/)
  expect(shown).toContain('for up to ~11.8h away')
})
