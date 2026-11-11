// The panel's content as rows of styled pieces. Pure: the register draws them as Text in a Box.

import { apiRatios, fmtDur, fmtHours, fmtK, fmtUsd, ratiosFor, TTL_MS, toUsd } from './model.ts'
import type { Basis, Pick, Plan, Price } from './model.ts'
import type { ContextSplit } from './split.ts'

export type Piece = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type Row = Piece[]

const BAR_CELLS = 20

/** A bar of the cache's hour: filled for the time left, green, amber in the last ten minutes, red when out. */
export function cacheBar(leftMs: number): Piece[] {
  const share = Math.max(0, Math.min(1, leftMs / TTL_MS))
  const filled = Math.round(share * BAR_CELLS)
  const color = leftMs <= 0 ? 'red' : leftMs <= 10 * 60_000 ? 'yellow' : 'green'
  return [
    { text: '█'.repeat(filled), color },
    { text: '░'.repeat(BAR_CELLS - filled), dim: true },
  ]
}

const pad = (text: string, width: number) => (text.length >= width ? `${text} ` : text.padEnd(width))

export type PanelInput = {
  price: Price
  basis: Basis
  ctx: number
  /** Time left on the cache (negative: cold for that long); undefined before any request. */
  leftMs?: number
  plan: Plan
  isCompactAhead: boolean
  isSmall: boolean
  narrow: boolean
  /** The fixed part and the conversation; absent when the breakdown has no Messages row. */
  split?: ContextSplit
}

/**
 * The panel above its controls: the cache's bar and countdown, what the next message costs now and
 * once cold, then the options for the time away with the cheapest marked, and one line of advice.
 */
export function panelRows(input: PanelInput): Row[] {
  const { price, basis, ctx, leftMs, plan, isCompactAhead, isSmall, narrow, split } = input
  const x = ratiosFor(basis, price)
  const api = apiRatios(price)
  const rows: Row[] = []
  const isCold = leftMs !== undefined && leftMs <= 0
  const status = leftMs === undefined ? 'no request yet' : isCold ? `cold for ${fmtDur(-leftMs)}` : `${fmtDur(leftMs)} left`
  rows.push([
    { text: 'Cache ', bold: true, color: 'cyan' },
    ...(narrow ? [] : [...cacheBar(leftMs ?? 0), { text: ' ' }]),
    { text: status, bold: true, color: isCold ? 'red' : leftMs !== undefined && leftMs <= 10 * 60_000 ? 'yellow' : undefined },
  ])
  rows.push([{ text: `${price.id} · ${fmtK(ctx)} tokens${price.isGuess ? ' · price guessed' : ''}`, dim: true }])
  if (split) {
    // Narrow panes keep the two totals and drop the sub-part list.
    const parts = narrow || split.parts.length === 0 ? '' : ` (${split.parts.map(part => `${part.label} ${fmtK(part.tokens)}`).join(' · ')})`
    rows.push([{ text: `fixed ${fmtK(split.fixed)}${parts}`, dim: true }])
    rows.push([{ text: `conversation ${fmtK(split.conversation)}`, dim: true }])
  }
  rows.push([])
  const warmNext = ctx * x.r
  const coldNext = ctx * x.w
  rows.push([
    { text: 'Next message ', bold: true, color: 'cyan' },
    { text: isCold ? 'rewrites the cache: ' : 'now: ', dim: true },
    { text: `~${fmtK(isCold ? coldNext : warmNext)}`, color: isCold ? 'red' : 'green' },
    { text: ` ${fmtUsd(toUsd(ctx * (isCold ? api.w : api.r), price))}`, dim: true },
    ...(isCold
      ? []
      : [
          { text: ' · once cold: ', dim: true },
          { text: `~${fmtK(coldNext)}`, color: 'red' },
          { text: ` ${fmtUsd(toUsd(ctx * api.w, price))}`, dim: true },
        ]),
  ])
  rows.push([])
  if (isCold) {
    rows.push([{ text: 'The cache is already cold: nothing to save now. Just send.', dim: true }])
    return rows
  }
  rows.push([{ text: 'Away for ', bold: true, color: 'cyan' }, { text: fmtHours(plan.hours), bold: true }, { text: ' (change the hours below)', dim: true }])
  const colorOf: Record<Pick, string> = { warm: 'green', compact: 'magenta', nothing: 'red' }
  const options: Array<[Pick, string, string, number, number]> = [
    ['warm', 'Keep warm', `${plan.pings} ping${plan.pings === 1 ? '' : 's'}`, plan.warmUnits, plan.warmUsd],
    ['compact', 'Compact now', '', plan.compactUnits, plan.compactUsd],
    ['nothing', 'Do nothing', '', plan.nothingUnits, plan.nothingUsd],
  ]
  for (const [pick, label, detail, units, usd] of options) {
    const isOut = pick === 'warm' && isCompactAhead
    const isBest = !isOut && !isSmall && pick === plan.recommended
    rows.push([
      { text: isBest ? '▸ ' : '  ', color: 'green', bold: true },
      { text: pad(label, 13), bold: isBest, dim: isOut, color: isOut ? undefined : colorOf[pick] },
      ...(narrow ? [] : [{ text: pad(detail, 10), dim: true }]),
      { text: pad(isOut ? 'n/a' : `~${fmtK(units)}`, 8), bold: isBest, dim: isOut },
      { text: isOut ? '' : fmtUsd(usd), dim: true },
      ...(isBest && !narrow ? [{ text: '  ◂ cheapest', color: 'green', bold: true }] : []),
    ])
  }
  rows.push([])
  let advice: string
  if (isSmall) advice = 'A small conversation: going cold costs little. Do nothing.'
  else if (isCompactAhead) advice = 'Claude Code compacts this conversation itself at minute 54; keep-warm cannot stop it. Hand off first if you want more than a summary.'
  else if (plan.recommended === 'warm') advice = `Keep-warm stays cheaper than compacting for up to ~${plan.breakEvenHours.toFixed(1)}h away.`
  else if (plan.recommended === 'compact') advice = `Away that long, compacting beats ${plan.pings} pings. A handoff keeps more than the summary.`
  else advice = 'Letting it go cold is the cheapest here.'
  rows.push([{ text: advice, dim: true }])
  rows.push([{ text: basis === 'subscription' ? '~ token-equivalent on your plan · $ at API prices' : '~ token-equivalent · $ at API prices', dim: true }])
  return rows
}

export type ActionId = 'stop' | 'warm' | 'then-compact' | 'once' | 'handoff' | 'compact' | 'close'
export type Action = { id: ActionId; hotkey: string; label: string; hint: string; color?: string; isBest?: true }

/**
 * The panel's actions as a menu: a hotkey, a label in its option's colour, and a dim sentence under
 * it saying what it does. Only what still makes sense is listed; the cheapest option is marked.
 */
// No hotkey is a digit or h: the hours field takes "1.5h".
export function panelActions(input: {
  isCold: boolean
  isCompactAhead: boolean
  isSmall: boolean
  hours: number
  recommended: Pick
  warming?: { leftMs: number; pings: number }
  isCompactAfter: boolean
}): Action[] {
  const { isCold, isCompactAhead, isSmall, hours, recommended, warming, isCompactAfter } = input
  if (isCold) return [{ id: 'close', hotkey: 'q', label: 'Close', hint: 'The cache is already cold, so there is nothing left to save. Just send your next message.' }]
  const best = (pick: Pick) => (!isSmall && recommended === pick ? ({ isBest: true } as const) : {})
  const actions: Action[] = []
  if (warming) {
    actions.push({ id: 'stop', hotkey: 's', label: 'Stop keep-warm', hint: `Keep-warm runs for ${fmtDur(warming.leftMs)} more (${warming.pings} ping${warming.pings === 1 ? '' : 's'} so far). Stop it and the cache goes cold an hour after the last ping.`, color: 'green' })
  } else if (!isCompactAhead) {
    actions.push({ id: 'warm', hotkey: 'w', label: `Keep warm ${fmtHours(hours)}`, hint: 'Sends a tiny hidden request every 50 minutes for the hours above, so the cache never expires while you are away. It does not add to the conversation.', color: 'green', ...best('warm') })
  }
  if (!isCompactAhead) {
    actions.push({ id: 'then-compact', hotkey: 't', label: `Then compact: ${isCompactAfter ? 'on' : 'off'}`, hint: 'If keep-warm runs out and you still have not typed, compact the conversation while the cache is warm, so coming back only costs the summary.', color: isCompactAfter ? 'green' : undefined })
    actions.push({ id: 'once', hotkey: 'p', label: 'Ping once', hint: 'One hidden request now, which gives the cache one more hour. For a short break.' })
  }
  actions.push({ id: 'handoff', hotkey: 'f', label: 'Write handoff', hint: 'Asks Claude to write a handoff file now, while the cache is warm. When you are back, /clear and start from it: it keeps more than a summary.', color: 'cyan' })
  actions.push({ id: 'compact', hotkey: 'c', label: 'Compact now', hint: "Runs Claude Code's /compact now, while the cache is warm and summarising is cheapest. The conversation shrinks to a summary.", color: 'magenta', ...best('compact') })
  return actions
}
