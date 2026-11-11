export type PingInfo = { at: number; read: number; write: number; out: number; isWarm: boolean }

export type Warm = {
  startedAt: number
  deadline: number
  pings: number
  /** Consecutive pings that wrote instead of read. One is tolerated: a young session's first ping writes its own entry. */
  misses: number
  last: PingInfo | null
}

/** The context split for the panel; hooks/split.ts builds it. */
export type ContextSplit = { fixed: number; conversation: number; parts: Array<{ label: string; tokens: number }> }

export type Snap = { ctx: number; model: string; hasLimits: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cache-nudge': {
      nowAt: number
      lastRequestAt: number
      nudgedFor: number
      hoursText: string
      warm: Warm | null
      snap: Snap
      /** The panel's fixed/conversation split, fetched when it opens; null when there is no breakdown. */
      split: ContextSplit | null
      note: string
      /** When keep-warm ends with you still away, compact while the cache is warm. Per session. */
      compactAfter: boolean
      /** When the main conversation last ran a turn: your activity, as opposed to a ping. */
      lastTurnAt: number
    }
  }
}
