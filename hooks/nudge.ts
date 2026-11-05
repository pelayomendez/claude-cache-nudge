// When to nudge, and the settings that tune it. Pure: no engine calls in here.

import { MIN, TTL_MS, thresholdTokens } from './model.ts'
import type { Price } from './model.ts'

export type Settings = {
  /** Idle time after the last request before the nudge. */
  remindAfterMs: number
  /** Context size below which a lapse is not worth a nudge; undefined: the model's own threshold. */
  minTokens?: number
  /** False when the cache lives five minutes: a nudge before every short pause helps no one. */
  isHourCache: boolean
  /** Context size from which Claude Code compacts an idle conversation at minute 54 by itself. */
  idleCompactAt: number
}

const DEFAULT_REMIND_MIN = 50
const DEFAULT_IDLE_COMPACT_AT = 200_000

function whole(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text.trim())) return undefined
  return Number(text.trim())
}

/**
 * Settings from the environment:
 * - CACHE_NUDGE_REMIND_MIN: minutes idle before the nudge, 10 to 58 (default 50)
 * - CACHE_NUDGE_MIN_TOKENS: nudge only from this context size (default: where a lapse costs ~$0.30)
 * - the cache lifetime from CLAUDE_CODE_PROMPT_CACHE_TTL, FORCE_PROMPT_CACHING_5M and
 *   ENABLE_PROMPT_CACHING_1H; one hour unless one of them says five minutes
 * - CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: where Claude Code's own idle compaction starts (200000)
 */
export function settingsFrom(env: Record<string, string | undefined>): Settings {
  const minutes = whole(env.CACHE_NUDGE_REMIND_MIN)
  const ttl = (env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? '').trim().toLowerCase()
  const isFiveMinutes = ttl === '5m' || ttl === '300' || ttl === '300s' || env.FORCE_PROMPT_CACHING_5M === '1'
  return {
    remindAfterMs: (minutes !== undefined && minutes >= 10 && minutes <= 58 ? minutes : DEFAULT_REMIND_MIN) * MIN,
    minTokens: whole(env.CACHE_NUDGE_MIN_TOKENS),
    isHourCache: !isFiveMinutes,
    idleCompactAt: Math.max(100_000, whole(env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS) ?? DEFAULT_IDLE_COMPACT_AT),
  }
}

export type NudgeInput = {
  now: number
  /** When the main conversation last sent a request: the cache's hour starts there. 0: none yet. */
  lastRequestAt: number
  /** The last request this stretch was already nudged for. */
  nudgedFor: number
  isWarming: boolean
  ctx: number
  price: Price
}

/** Whether to nudge now: idle long enough, cache still warm, not yet nudged, and worth it. */
export function shouldNudge(input: NudgeInput, settings: Settings): boolean {
  const { now, lastRequestAt, nudgedFor, isWarming, ctx, price } = input
  if (!settings.isHourCache || lastRequestAt === 0 || isWarming) return false
  if (nudgedFor === lastRequestAt) return false
  const idle = now - lastRequestAt
  if (idle < settings.remindAfterMs - 1000 || idle >= TTL_MS) return false
  return ctx >= (settings.minTokens ?? thresholdTokens(price))
}

/**
 * Whether Claude Code will compact this conversation by itself at minute 54 whatever keep-warm
 * does: a keep-warm ping does not postpone it, so above this size keep-warm cannot hold.
 */
export function isIdleCompactAhead(ctx: number, settings: Settings, isIdleCompactionOn: boolean): boolean {
  return isIdleCompactionOn && ctx >= settings.idleCompactAt
}

/** The prompt behind "Write handoff": a visible request, so the person sees what the model does. */
export const HANDOFF_PROMPT =
  'I am stepping away and this conversation\'s prompt cache is about to expire. Write a handoff for this session where this project keeps its handoffs (or HANDOFF.md at the repository root if it keeps none): what we are doing, what is done, what is next, open questions, and the files that matter, so a fresh session can continue from it alone. Then tell me in one line where you wrote it, so I can /clear.'

/** The herdr argv for a notification. The body goes as --body=<text>, so text starting with "--" stays text. */
export function herdrNotifyArgv(bin: string, title: string, body: string): string[] {
  return [bin, 'notification', 'show', title, `--body=${body}`, '--sound', 'done']
}

/** The folder name a notification says the session is in. */
export function folderOf(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

export type BandButton = 'warm' | 'handoff' | 'stop' | 'more'
export type BandView = { text: string; color: 'green' | 'yellow' | 'red'; buttons: BandButton[] }

/** How close to expiry the band turns amber: the nudge's own window. */
export const AMBER_MS = 10 * MIN

function minutesText(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN))
  return total >= 60 ? `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m` : `${total}m`
}

function tokensText(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/**
 * The band above the prompt: the cache's countdown and the conversation's size, coloured green,
 * amber in the last ten minutes and red once cold, with the actions that still make sense.
 * Undefined, nothing drawn, before the first request and while the conversation is too small for
 * a lapse to matter (unless keep-warm runs).
 */
export function bandView(input: {
  now: number
  lastRequestAt: number
  ctx: number
  minTokens: number
  warmDeadline?: number
  isCompactAhead: boolean
  columns: number
}): BandView | undefined {
  const { now, lastRequestAt, ctx, minTokens, warmDeadline, isCompactAhead, columns } = input
  const size = tokensText(ctx)
  const fit = (view: BandView): BandView =>
    columns < 30 ? { ...view, text: view.text.split(' · ')[0] ?? view.text, buttons: [] } : columns < 56 ? { ...view, buttons: view.buttons.filter(one => one === 'more' || one === 'stop') } : view
  if (warmDeadline !== undefined && now < warmDeadline) {
    return fit({ text: `warm ${minutesText(warmDeadline - now)} · ${size}`, color: 'green', buttons: ['stop', 'more'] })
  }
  if (lastRequestAt === 0 || ctx < minTokens) return undefined
  const left = lastRequestAt + TTL_MS - now
  if (left <= 0) return fit({ text: `cache cold · next message re-caches ${size}`, color: 'red', buttons: [] })
  return fit({
    text: `cache ${minutesText(left)} left · ${size}`,
    color: left <= AMBER_MS ? 'yellow' : 'green',
    buttons: isCompactAhead ? ['handoff', 'more'] : ['warm', 'handoff', 'more'],
  })
}

/** Whether Claude Code's idle compaction can run: its own row, and auto-compact, both on. */
export function idleCompactionOn(rows: { idleCompaction?: unknown; autoCompactEnabled?: unknown }, env: { DISABLE_AUTO_COMPACT?: string }): boolean {
  if (env.DISABLE_AUTO_COMPACT === '1' || env.DISABLE_AUTO_COMPACT === 'true') return false
  return rows.idleCompaction !== false && rows.autoCompactEnabled !== false
}
