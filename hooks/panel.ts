// The panel's content as rows of styled pieces. Pure: the register draws them as Text in a Box.

import { apiRatios, fmtDur, fmtHours, fmtK, fmtUsd, ratiosFor, TTL_MS, toUsd } from './model.ts'
import type { Basis, Pick, Plan, Price } from './model.ts'

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
}

/**
 * The panel above its controls: the cache's bar and countdown, what the next message costs now and
 * once cold, then the options for the time away with the cheapest marked, and one line of advice.
 */
export function panelRows(input: PanelInput): Row[] {
  const { price, basis, ctx, leftMs, plan, isCompactAhead, isSmall, narrow } = input
  const x = ratiosFor(basis, price)
  const api = apiRatios(price)
  const rows: Row[] = []
  const isCold = leftMs !== undefined && leftMs <= 0
  const status = leftMs === undefined ? 'no request yet' : isCold ? `cold for ${fmtDur(-leftMs)}` : `${fmtDur(leftMs)} left`
  rows.push([
    { text: 'Cache ', bold: true },
    ...(narrow ? [] : [...cacheBar(leftMs ?? 0), { text: ' ' }]),
    { text: status, bold: true, color: isCold ? 'red' : leftMs !== undefined && leftMs <= 10 * 60_000 ? 'yellow' : undefined },
  ])
  rows.push([{ text: `${price.id} · ${fmtK(ctx)} tokens${price.isGuess ? ' · price guessed' : ''}`, dim: true }])
  rows.push([])
  const warmNext = ctx * x.r
  const coldNext = ctx * x.w
  rows.push([
    { text: 'Next message ', bold: true },
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
  rows.push([{ text: `Away for ${fmtHours(plan.hours)}:`, bold: true }])
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
      { text: pad(label, 13), bold: isBest, dim: isOut },
      ...(narrow ? [] : [{ text: pad(detail, 10), dim: true }]),
      { text: pad(isOut ? 'n/a' : `~${fmtK(units)}`, 8), color: isBest ? 'green' : undefined, dim: isOut },
      { text: isOut ? '' : fmtUsd(usd), dim: true },
      ...(isBest && !narrow ? [{ text: '  cheapest', color: 'green' }] : []),
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
