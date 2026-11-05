// cache-nudge: one nudge before an idle session's prompt cache goes cold, then your choice of what
// to do about it. Adapted from cache-panel by Dustin Yuchen Teng (MIT).
//
// Nothing happens on its own but the nudge: a line above the prompt, a system notification and,
// inside herdr, a herdr notification. Every other action is the person's: the band button or /nudge.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PingInfo, Snap, Warm } from '../types'
import {
  DEFAULT_HOURS,
  HOUR,
  MAX_HOURS,
  PING_EVERY_MS,
  TTL_MS,
  fmtDur,
  fmtHours,
  fmtK,
  makePlan,
  optionRows,
  parseHours,
  pickLabel,
  priceOf,
  thresholdTokens,
} from './model.ts'
import { HANDOFF_PROMPT, bandView, folderOf, herdrNotifyArgv, idleCompactionOn, isIdleCompactAhead, settingsFrom, shouldNudge } from './nudge.ts'
import type { Settings } from './nudge.ts'

const PANE = 'cache-nudge'
const TICK_MS = 30_000
const TOAST_MS = 5000
const PING_PROMPT = 'Reply with exactly: ok'

const EMPTY_SNAP: Snap = { ctx: 0, model: '', hasLimits: false }

const nowAt = atom({ plugin: 'cache-nudge', key: 'nowAt' } as const, 0)
const lastRequestAt = atom({ plugin: 'cache-nudge', key: 'lastRequestAt' } as const, 0)
const nudgedFor = atom({ plugin: 'cache-nudge', key: 'nudgedFor' } as const, 0)
const hoursText = atom({ plugin: 'cache-nudge', key: 'hoursText' } as const, '')
const warm = atom({ plugin: 'cache-nudge', key: 'warm' } as const, null)
const snap = atom({ plugin: 'cache-nudge', key: 'snap' } as const, EMPTY_SNAP)
const note = atom({ plugin: 'cache-nudge', key: 'note' } as const, '')

let settings: Settings = settingsFrom({})
let remindTimer: Timer | undefined
let pingTimer: Timer | undefined
// Bumped by every armPing: a call overtaken by a later one drops its timer instead of orphaning it.
let pingGeneration = 0
let isPinging = false
// Claude Code's own idle compaction, read at start and on each tick, not on every band render.
let compactionOn = true

async function refreshSnap($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const model = await $.session.model()
  const next: Snap = { ctx: usage.context.tokens ?? 0, model, hasLimits: usage.rateLimits.length > 0 }
  const held = await read($, snap)
  // An unchanged snapshot is not written: a write redraws the band.
  if (held.ctx === next.ctx && held.model === next.model && held.hasLimits === next.hasLimits) return
  await update($, snap, () => next)
}

/** Whether Claude Code's own idle compaction can run: its /config rows and DISABLE_AUTO_COMPACT. */
async function isIdleCompactionOn($: EngineInterface): Promise<boolean> {
  try {
    const rows = await $.config.list()
    const value = (key: string) => rows.find(each => each.key === key)?.value
    return idleCompactionOn(
      { idleCompaction: value('idleCompaction'), autoCompactEnabled: value('autoCompactEnabled') },
      { DISABLE_AUTO_COMPACT: await $.env.get('DISABLE_AUTO_COMPACT') },
    )
  } catch {
    return true
  }
}

/** The nudge's notifications: the person's own channel, and herdr's when the session runs in it. */
async function notify($: EngineInterface, title: string, body: string): Promise<void> {
  void $.ui.notify(body, { title }).catch(() => undefined)
  if ((await $.env.get('HERDR_ENV')) !== '1') return
  const bin = (await $.env.get('HERDR_BIN_PATH')) || 'herdr'
  try {
    await $.process.run(herdrNotifyArgv(bin, title, body), { timeoutMs: 5000 })
  } catch (error) {
    $.ui.log(`herdr notification failed: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
  }
}

async function isWarmNow($: EngineInterface, now: number): Promise<boolean> {
  const current = await read($, warm)
  return current !== null && now < current.deadline
}

/** The nudge, once per idle stretch, when shouldNudge says so. */
async function remindIfDue($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  const last = await read($, lastRequestAt)
  if (last === 0) return
  await refreshSnap($)
  const current = await read($, snap)
  const input = {
    now,
    lastRequestAt: last,
    nudgedFor: await read($, nudgedFor),
    isWarming: await isWarmNow($, now),
    ctx: current.ctx,
    price: priceOf(current.model),
  }
  if (!shouldNudge(input, settings)) return
  await update($, nudgedFor, () => last)
  const cwd = await $.session.cwd()
  await notify($, `Cache cools in ${fmtDur(last + TTL_MS - now)}`, `${folderOf(cwd)} · ${fmtK(current.ctx)} tokens`)
}

function armReminder($: EngineInterface, delay = settings.remindAfterMs): void {
  remindTimer?.cancel()
  remindTimer = $.clock.after(Math.max(1000, delay), () => void remindIfDue($))
}

/** The next keep-warm ping, one period after the last request that touched the cache. */
async function armPing($: EngineInterface): Promise<void> {
  pingTimer?.cancel()
  pingTimer = undefined
  const generation = ++pingGeneration
  const current = await read($, warm)
  if (current === null) return
  const now = await $.clock.now()
  if (now >= current.deadline) {
    await endWarm($, 'expired')
    return
  }
  const last = await read($, lastRequestAt)
  if (last === 0) return
  // A cache already cold (a laptop that slept through the ping) is not worth paying to rewrite.
  if (now - last >= TTL_MS) {
    await endWarm($, 'error', 'Keep-warm stopped: the cache went cold')
    return
  }
  if (generation !== pingGeneration) return
  const delay = Math.min(Math.max(1000, last + PING_EVERY_MS - now), current.deadline - now)
  pingTimer = $.clock.after(delay, () => void runPing($))
}

/** A request, or a ping, touched the cache just now. */
async function touch($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  await update($, lastRequestAt, () => now)
  armReminder($)
  await armPing($)
}

async function runPing($: EngineInterface): Promise<void> {
  pingTimer = undefined
  if (isPinging) return
  const current = await read($, warm)
  if (current === null) return
  const now = await $.clock.now()
  if (now >= current.deadline) {
    await endWarm($, 'expired')
    return
  }
  // A request since the timer was set moved the ping later.
  if (now - (await read($, lastRequestAt)) < PING_EVERY_MS - 1000) {
    await armPing($)
    return
  }
  isPinging = true
  try {
    await doPing($, 'window')
  } finally {
    isPinging = false
  }
}

async function endWarm($: EngineInterface, why: 'expired' | 'stopped' | 'error', message?: string): Promise<void> {
  pingTimer?.cancel()
  pingTimer = undefined
  pingGeneration++
  // Already ended (the deadline timer and the tick can both get here): one toast.
  if ((await read($, warm)) === null) return
  await update($, warm, () => null)
  if (why === 'expired') $.ui.toast('Keep-warm ended', { timeoutMs: TOAST_MS })
  else if (why === 'stopped') $.ui.toast('Keep-warm stopped', { timeoutMs: TOAST_MS })
  else $.ui.toast(message ?? 'Keep-warm stopped: ping failed', { timeoutMs: 8000 })
  await remindIfDue($)
}

/** One tool-less fork over the conversation: the API serves it from the cache and its hour restarts. */
async function doPing($: EngineInterface, kind: 'window' | 'once'): Promise<void> {
  const now = await $.clock.now()
  const last = await read($, lastRequestAt)
  if (last > 0 && now - last >= TTL_MS) {
    if (kind === 'window') await endWarm($, 'error', 'Keep-warm stopped: the cache went cold')
    else $.ui.toast('The cache is already cold', { timeoutMs: TOAST_MS })
    return
  }
  let reply: Awaited<ReturnType<EngineInterface['model']['fork']>> | undefined
  let failure = ''
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  const usage = reply !== undefined && 'usage' in reply ? reply.usage : undefined
  if (usage === undefined) {
    const why = reply !== undefined && !reply.isAnswered ? reply.reason : failure || 'no reply'
    if (kind === 'window') await endWarm($, 'error', `Keep-warm stopped: ping failed (${why})`)
    else $.ui.toast(`Ping failed: ${why}`, { timeoutMs: 8000 })
    return
  }
  const isWarm = usage.cache_read_input_tokens > 0 && usage.cache_creation_input_tokens < 0.1 * usage.cache_read_input_tokens
  const info: PingInfo = { at: now, read: usage.cache_read_input_tokens, write: usage.cache_creation_input_tokens, out: usage.output_tokens, isWarm }
  await update($, note, () =>
    isWarm ? `Last ping: read ${fmtK(info.read)} from the cache` : `Last ping: read ${fmtK(info.read)}, wrote ${fmtK(info.write)} (a new entry)`,
  )
  if (!isWarm && kind === 'window') {
    // A young session's first ping writes an entry of its own: one such miss in a row is tolerated.
    const current = await read($, warm)
    if (current !== null && current.misses === 0) {
      await update($, warm, (held: Warm | null) => (held === null ? null : { ...held, misses: 1, last: info }))
    } else {
      await endWarm($, 'error', `Keep-warm stopped: pings keep missing the cache (wrote ${fmtK(info.write)})`)
      return
    }
  } else if (kind === 'window') {
    await update($, warm, (held: Warm | null) => (held === null ? null : { ...held, pings: held.pings + 1, misses: 0, last: info }))
  } else {
    $.ui.toast(isWarm ? `Pinged: the cache holds another hour` : `Pinged: wrote ${fmtK(info.write)}, the cache holds another hour`, { timeoutMs: TOAST_MS })
  }
  await touch($)
}

async function startWarm($: EngineInterface, hours: number): Promise<void> {
  const now = await $.clock.now()
  const last = await read($, lastRequestAt)
  if (last > 0 && now - last >= TTL_MS) {
    $.ui.toast('The cache is already cold', { timeoutMs: TOAST_MS })
    return
  }
  await update($, warm, () => ({ startedAt: now, deadline: now + hours * HOUR, pings: 0, misses: 0, last: null }))
  await armPing($)
  $.ui.toast(`Keep-warm on for ${fmtHours(hours)}`, { timeoutMs: 3000 })
  await $.ui.close({ id: PANE })
}

async function openPanel($: EngineInterface): Promise<void> {
  await refreshSnap($)
  await update($, nowAt, await $.clock.now().then(now => () => now))
  await update($, hoursText, () => '')
  await $.ui.open({ id: PANE, title: 'Cache', focus: true, closeOnEscape: true, rows: 13 })
}

async function compactNow($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  try {
    await $.command.run({ command: 'compact', args: '' })
  } catch (error) {
    $.ui.toast(`Compact failed: ${error instanceof Error ? error.message : String(error)}`, { timeoutMs: 8000 })
  }
}

/** Asks the model, in a visible turn, to write a handoff while the cache is still warm. */
async function writeHandoff($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  try {
    await $.prompt.submit({ text: HANDOFF_PROMPT })
  } catch (error) {
    $.ui.toast(`Could not ask for a handoff: ${error instanceof Error ? error.message : String(error)}`, { timeoutMs: 8000 })
  }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  await refreshSnap($)
  compactionOn = await isIdleCompactionOn($)
  const current = await read($, warm)
  if (current !== null && now >= current.deadline) await endWarm($, 'expired')
  // A safety net for a nudge whose timer was lost (a reload, a laptop asleep at the time).
  else await remindIfDue($)
}

/** After a reload or a re-enable, the state is back but its timers are not: arm them again. */
async function rearm($: EngineInterface): Promise<void> {
  const last = await read($, lastRequestAt)
  if (last === 0) return
  const now = await $.clock.now()
  if (now - last < TTL_MS) armReminder($, last + settings.remindAfterMs - now)
  await armPing($)
}

function stopTimers(): void {
  remindTimer?.cancel()
  remindTimer = undefined
  pingTimer?.cancel()
  pingTimer = undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    settings = settingsFrom({
      CACHE_NUDGE_REMIND_MIN: await $.env.get('CACHE_NUDGE_REMIND_MIN'),
      CACHE_NUDGE_MIN_TOKENS: await $.env.get('CACHE_NUDGE_MIN_TOKENS'),
      CLAUDE_CODE_PROMPT_CACHE_TTL: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
      FORCE_PROMPT_CACHING_5M: await $.env.get('FORCE_PROMPT_CACHING_5M'),
      CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'),
    })
    await update($, nowAt, await $.clock.now().then(now => () => now))
    await refreshSnap($)
    compactionOn = await isIdleCompactionOn($)
    await rearm($)
    $.clock.every(TICK_MS, () => void tick($))
    await $.command.register({
      name: 'nudge',
      description: 'Prompt cache: open the panel (keep warm, ping, handoff, compact), or /nudge off to stop keep-warm',
      argumentHint: '[hours | off]',
      immediate: true,
    })
    return next(e)
  })

  // /clear starts another conversation, cold. A resume or a fork may find the old one's cache still
  // warm: its last response says how long ago it was cached.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    stopTimers()
    pingGeneration++
    await update($, warm, () => null)
    const now = await $.clock.now()
    const ago = e.source === 'clear' ? undefined : e.seconds_since_last_response
    const isWarm = ago !== undefined && ago * 1000 < TTL_MS
    await update($, lastRequestAt, () => (isWarm ? now - ago * 1000 : 0))
    if (isWarm) armReminder($, settings.remindAfterMs - ago * 1000)
    await refreshSnap($)
    return next(e)
  })

  // A turn starts with a request, and each later step of it sends another: the cache's hour
  // starts at the latest one.
  // The request is not held up for the bookkeeping.
  on('turn.start', ($, e, next) => {
    if (!e.agentId) void touch($).catch(() => undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) void touch($).catch(() => undefined)
    return yield* next(e)
  })

  // A compaction replaced the conversation: the new one is cold until its next request.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    // A precompute installs nothing, and a skipped compaction leaves the conversation as it was.
    if (!e.agentId && e.trigger !== 'precompute' && result.messages !== undefined) {
      stopTimers()
      await update($, warm, () => null)
      await update($, lastRequestAt, () => 0)
    }
    return result
  })

  on('command.run', { command: 'nudge' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === '') {
      await openPanel($)
      return {}
    }
    if (arg === 'off' || arg === 'stop') {
      if ((await read($, warm)) === null) return { text: 'Keep-warm is not running.' }
      await endWarm($, 'stopped')
      return {}
    }
    const hours = parseHours(arg)
    if (hours === null) return { text: `Usage: /nudge [hours 0-${MAX_HOURS} | off]` }
    await refreshSnap($)
    if (isIdleCompactAhead((await read($, snap)).ctx, settings, compactionOn)) {
      return { text: 'This conversation is over the idle-compaction size: Claude Code will compact it at minute 54 whatever keep-warm does. Hand off or compact instead.' }
    }
    await startWarm($, hours)
    return {}
  })

  // The band: the cache's countdown and the conversation's size, with the actions that still make
  // sense. Drawn once the conversation is big enough for a lapse to matter, or while keep-warm runs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, snap)
    const warming = await read($, warm)
    const view = bandView({
      now: await read($, nowAt),
      lastRequestAt: await read($, lastRequestAt),
      ctx: current.ctx,
      minTokens: settings.minTokens ?? thresholdTokens(priceOf(current.model)),
      warmDeadline: warming?.deadline,
      isCompactAhead: isIdleCompactAhead(current.ctx, settings, compactionOn),
      columns: e.props.bodyColumns,
    })
    if (!view) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const actions = {
      warm: { label: 'warm', press: () => void startWarm($, DEFAULT_HOURS) },
      handoff: { label: 'handoff', press: () => void writeHandoff($) },
      stop: { label: 'stop', press: () => void endWarm($, 'stopped') },
      more: { label: 'more', press: () => void openPanel($) },
    } as const
    const mine = (
      <Box key="cache-nudge" flexDirection="row" justifyContent="flex-end">
        <Text color={view.color} dimColor={view.isQuiet}>
          {view.text}
        </Text>
        {view.buttons.map(name => (
          <Box key={name} flexDirection="row">
            <Text> </Text>
            <Button key={name} label={actions[name].label} onPress={actions[name].press} />
          </Box>
        ))}
      </Box>
    )
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // Text fields exist in the terminal and the desktop app only.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const current = await read($, snap)
    const now = await read($, nowAt)
    const last = await read($, lastRequestAt)
    const warming = await read($, warm)
    const typed = await read($, hoursText)
    const lastNote = await read($, note)
    const isCompactAhead = isIdleCompactAhead(current.ctx, settings, compactionOn)

    const price = priceOf(current.model)
    const basis = current.hasLimits ? 'subscription' : 'api'
    const parsed = parseHours(typed)
    const hours = parsed ?? DEFAULT_HOURS
    const isCold = last > 0 && now - last >= TTL_MS
    const plan = makePlan({ ctx: current.ctx, price, basis, hours, lastReq: last, now, isWarm: !isCold })
    const narrow = e.props.bodyColumns < 44

    const cacheText = isCold ? `cold ${fmtDur(now - last - TTL_MS)}` : last > 0 ? `${fmtDur(last + TTL_MS - now)} left` : 'no request yet'
    let advice: string
    if (parsed === null) advice = `Hours: 0 to ${MAX_HOURS}`
    else if (isCold) advice = 'The cache is cold: just send.'
    else if (current.ctx < (settings.minTokens ?? thresholdTokens(price))) advice = 'Small context: do nothing.'
    else if (isCompactAhead) advice = 'Over the idle-compaction size: keep-warm cannot stop it. Hand off or compact.'
    else advice = narrow ? `Best: ${pickLabel(plan.recommended)}` : `Best: ${pickLabel(plan.recommended)} (warm wins up to ~${plan.breakEvenHours.toFixed(1)}h)`
    const legend = basis === 'subscription' ? '~ token-equivalent (plan) · $ at API prices' : '~ token-equivalent · $ at API prices'

    return (
      <Box flexDirection="column">
        <Text bold>{`${price.id} · ${fmtK(current.ctx)} tokens · cache ${cacheText}${price.isGuess ? ' · price guessed' : ''}`}</Text>
        <Input
          key="hours"
          label="Away (hours)"
          placeholder={String(DEFAULT_HOURS)}
          value={typed}
          submitLabel="warm"
          onInput={(value: string) => void update($, hoursText, () => value)}
          onSubmit={(value: string) => {
            const chosen = parseHours(value)
            if (chosen === null) $.ui.toast(`Enter hours between 0 and ${MAX_HOURS}`, { timeoutMs: TOAST_MS })
            else void startWarm($, chosen)
          }}
        />
        {optionRows(plan, !isCold, narrow).map((line, at) => (
          <Text key={`row-${at}`}>{line}</Text>
        ))}
        {!narrow && <Text dimColor>{lastNote !== '' ? lastNote : legend}</Text>}
        <Text>{advice}</Text>
        {warming !== null && (
          <Button
            key="stop"
            label={`Stop keep-warm (${fmtDur(warming.deadline - now)} left, ${warming.pings} ping${warming.pings === 1 ? '' : 's'})`}
            autoFocus
            onPress={() => void endWarm($, 'stopped')}
          />
        )}
        {warming === null && !isCold && !isCompactAhead && (
          <Button
            key="warm"
            label={`Keep warm ${fmtHours(hours)}`}
            autoFocus
            onPress={() => {
              if (parsed === null) $.ui.toast(`Enter hours between 0 and ${MAX_HOURS}`, { timeoutMs: TOAST_MS })
              else void startWarm($, parsed)
            }}
          />
        )}
        {!isCold && !isCompactAhead && <Button key="once" label="Ping once (+1h)" onPress={() => void doPing($, 'once')} />}
        {!isCold && <Button key="handoff" label="Write handoff" onPress={() => void writeHandoff($)} />}
        <Button key="compact" label="Compact now" onPress={() => void $.clock.after(50, () => void compactNow($))} />
        {isCold && <Button key="close" label="Dismiss" autoFocus onPress={() => void $.ui.close({ id: PANE })} />}
      </Box>
    )
  })
}
