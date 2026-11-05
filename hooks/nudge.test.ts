import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { MIN, priceOf } from './model.ts'
import { HANDOFF_PROMPT, bandView, folderOf, herdrNotifyArgv, idleCompactionOn, isIdleCompactAhead, settingsFrom, shouldNudge } from './nudge.ts'

const OPUS = priceOf('claude-opus-5-5')
const HOUR_CACHE = settingsFrom({})
const at50 = { now: 50 * MIN, lastRequestAt: 1, nudgedFor: 0, isWarming: false, ctx: 120_000, price: OPUS }

test('settings: defaults, sane overrides, garbage ignored, and a five-minute cache', () => {
  expect(HOUR_CACHE).toEqual({ remindAfterMs: 50 * MIN, minTokens: undefined, isHourCache: true, idleCompactAt: 200_000 })
  expect(settingsFrom({ CACHE_NUDGE_REMIND_MIN: '40', CACHE_NUDGE_MIN_TOKENS: '60000' })).toMatchObject({ remindAfterMs: 40 * MIN, minTokens: 60_000 })
  expect(settingsFrom({ CACHE_NUDGE_REMIND_MIN: '59' }).remindAfterMs).toBe(50 * MIN)
  expect(settingsFrom({ CACHE_NUDGE_REMIND_MIN: '-5', CACHE_NUDGE_MIN_TOKENS: '1e9' })).toMatchObject({ remindAfterMs: 50 * MIN, minTokens: undefined })
  expect(settingsFrom({ CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }).isHourCache).toBe(false)
  expect(settingsFrom({ FORCE_PROMPT_CACHING_5M: '1' }).isHourCache).toBe(false)
  expect(settingsFrom({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '50000' }).idleCompactAt).toBe(100_000)
})

test('nudges once, at minute 50 of idle, while the cache is warm and the context worth it', () => {
  expect(shouldNudge(at50, HOUR_CACHE)).toBe(true)
  expect(shouldNudge({ ...at50, now: 45 * MIN }, HOUR_CACHE)).toBe(false)
  expect(shouldNudge({ ...at50, now: 61 * MIN }, HOUR_CACHE)).toBe(false)
  expect(shouldNudge({ ...at50, nudgedFor: 1 }, HOUR_CACHE)).toBe(false)
  expect(shouldNudge({ ...at50, isWarming: true }, HOUR_CACHE)).toBe(false)
  expect(shouldNudge({ ...at50, lastRequestAt: 0 }, HOUR_CACHE)).toBe(false)
  // Opus 5.5's threshold is ~38k tokens; a set minimum replaces it.
  expect(shouldNudge({ ...at50, ctx: 30_000 }, HOUR_CACHE)).toBe(false)
  expect(shouldNudge({ ...at50, ctx: 30_000 }, { ...HOUR_CACHE, minTokens: 20_000 })).toBe(true)
  expect(shouldNudge(at50, settingsFrom({ FORCE_PROMPT_CACHING_5M: '1' }))).toBe(false)
})

test('keep-warm cannot hold a conversation Claude Code will idle-compact', () => {
  expect(isIdleCompactAhead(250_000, HOUR_CACHE, true)).toBe(true)
  expect(isIdleCompactAhead(250_000, HOUR_CACHE, false)).toBe(false)
  expect(isIdleCompactAhead(150_000, HOUR_CACHE, true)).toBe(false)
})

test('the herdr body is one --body= argument, so a folder named like a flag stays text', () => {
  expect(herdrNotifyArgv('herdr', 'Cache cools in 10m', '--rm · 120k')).toEqual(['herdr', 'notification', 'show', 'Cache cools in 10m', '--body=--rm · 120k', '--sound', 'done'])
  expect(folderOf('/Users/me/work/api/')).toBe('api')
})

test('the handoff request is a plain visible prompt that ends by saying where it wrote', () => {
  expect(HANDOFF_PROMPT).toContain('Write a handoff')
  expect(HANDOFF_PROMPT).toContain('/clear')
})

const START = { cwd: '/w/api', surface: 'terminal', isInteractive: true } as const

function engine(on: On, ctx: number) {
  // Not 0: a last request at 0 reads as none yet.
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/w/api' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 12, tokens: ctx }, rateLimits: [] } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  const notices: string[] = []
  on('ui.notify', ($, e) => (notices.push(e.text), { value: { isSent: true, channel: 'terminal_bell' } }) as never)
  const runs: string[][] = []
  on('process.run', ($, e) => (runs.push([...e.argv]), { value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  const prompts: string[] = []
  on('prompt.submit', ($, e) => (prompts.push(e.text), { text: e.text }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('config.list', () => ({ value: [] }) as never)
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)
  const toasts: string[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }) as never)
  let forks = 0
  on('model.fork', () => (forks++, { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 } } }) as never)
  return { clock, notices, runs, prompts, toasts, forks: () => forks }
}

async function request($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.turn.start({ text: 'hi', turnId: 't' } as never)
}

test('in herdr, an idle large session is nudged once: the band, a system notification and herdr', async ($, on) => {
  mock.env(on, { HERDR_ENV: '1', HERDR_BIN_PATH: '/opt/herdr' })
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  const seen = engine(on, 120_000)
  await $.session.start(START)
  await request($)
  await seen.clock.advance(49 * MIN)
  expect(seen.notices).toEqual([])
  await seen.clock.advance(MIN + 1000)
  expect(seen.notices).toEqual(['api · 120k tokens'])
  expect(seen.runs).toEqual([['/opt/herdr', 'notification', 'show', 'Cache cools in 10m', '--body=api · 120k tokens', '--sound', 'done']])
  const band = await $.ui.mount({ plugin: 'cache-nudge', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as never)
  const drawn = JSON.stringify(await band.drawn())
  for (const text of ['cache 10m left · 120k', 'yellow', '"label":"warm"', '"label":"handoff"', '"label":"more"']) expect(drawn).toContain(text)
  await seen.clock.advance(30 * MIN)
  expect(seen.notices).toHaveLength(1)
})

test('the band: green countdown, amber in the last ten minutes, red when cold, hidden when small', () => {
  const base = { now: 18 * MIN, lastRequestAt: 0.0001, ctx: 120_000, minTokens: 38_462, isCompactAhead: false, columns: 100 }
  expect(bandView(base)).toEqual({ text: 'cache 42m left · 120k', color: 'green', buttons: ['more'], isQuiet: true })
  expect(bandView({ ...base, now: 52 * MIN })).toEqual({ text: 'cache 8m left · 120k', color: 'yellow', buttons: ['warm', 'handoff', 'more'] })
  expect(bandView({ ...base, now: 61 * MIN })).toEqual({ text: 'cache cold · next message re-caches 120k', color: 'red', buttons: [] })
  expect(bandView({ ...base, ctx: 20_000 })).toBeUndefined()
  expect(bandView({ ...base, lastRequestAt: 0 })).toBeUndefined()
  expect(bandView({ ...base, now: 52 * MIN, isCompactAhead: true })?.buttons).toEqual(['handoff', 'more'])
  expect(bandView({ ...base, warmDeadline: 18 * MIN + 192 * MIN })).toEqual({ text: 'warm 3h12m · 120k', color: 'green', buttons: ['stop', 'more'] })
  expect(bandView({ ...base, columns: 40 })?.buttons).toEqual(['more'])
  expect(bandView({ ...base, columns: 24 })).toEqual({ text: 'cache 42m left', color: 'green', buttons: [], isQuiet: true })
})

test('idle compaction needs its own row, auto-compact, and no DISABLE_AUTO_COMPACT', () => {
  expect(idleCompactionOn({}, {})).toBe(true)
  expect(idleCompactionOn({ idleCompaction: false }, {})).toBe(false)
  expect(idleCompactionOn({ autoCompactEnabled: false }, {})).toBe(false)
  expect(idleCompactionOn({}, { DISABLE_AUTO_COMPACT: '1' })).toBe(false)
})

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const typed = (args: string) => ({ command: 'nudge', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })

test('keep-warm pings every 50 minutes until its hours are up, then ends once and the band goes back to the countdown', async ($, on) => {
  mock.env(on, {})
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  const seen = engine(on, 120_000)
  await $.session.start(START)
  await request($)
  await seen.clock.advance(MIN)
  await $.command.run(typed('3') as never)
  const band = async () => JSON.stringify(await (await $.ui.mount({ plugin: 'cache-nudge', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS } as never)).drawn())
  expect(await band()).toContain('warm 3h')
  await seen.clock.advance(50 * MIN)
  expect(seen.forks()).toBe(1)
  await seen.clock.advance(3 * 60 * MIN)
  expect(seen.forks()).toBe(3)
  expect(seen.toasts.filter(text => text === 'Keep-warm ended')).toHaveLength(1)
  expect(await band()).not.toContain('warm 3h')
})

test('/nudge <hours> refuses keep-warm on a conversation Claude Code will idle-compact', async ($, on) => {
  mock.env(on, {})
  on('turn.start', ($$, e) => ({ turnId: e.turnId }))
  const seen = engine(on, 250_000)
  await $.session.start(START)
  await request($)
  const answer = await $.command.run(typed('3') as never)
  expect(answer.text).toContain('idle-compaction size')
  await seen.clock.advance(60 * MIN)
  expect(seen.forks()).toBe(0)
})
