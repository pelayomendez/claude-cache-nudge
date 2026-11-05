# claude-cache-nudge

A Claude Code plugin (`cache-nudge`) that nudges you once before an idle session's prompt cache goes cold, then lets you choose what to do about it.

## Why

Claude Code caches the conversation for an hour. While the cache is warm, each message reads the conversation at about a tenth of the input price; once it has expired, the next message writes the whole conversation back at about twice the input price. On a 150k-token conversation, that first message back costs as much as about 300k input tokens.

Most of the time that is fine. When you are about to step away from a large session, it is worth a decision.

## What it does

**A band above the prompt, on the right,** shows the cache's countdown and the conversation's size. Far from expiry it stays quiet, dim with one button:

```
                                                   cache 42m left · 120k [more]
```

In the last ten minutes it turns amber and brings out the actions:

```
                                       cache 8m left · 120k [warm] [handoff] [more]
```

Red once cold (`cache cold · next message re-caches 120k`). While keep-warm runs it reads `warm 3h12m · 120k [stop] [more]`. It stays hidden while the conversation is too small for a lapse to matter: about 38k tokens on Opus 5.5, 79k on Sonnet 5.5, where letting it go cold costs about $0.30. Narrow panes keep only `[more]`, then only the countdown.

**At minute 50 of idle,** with the cache still warm, it also nudges you once: a system notification, through the channel Claude Code uses for its own, and inside [herdr](https://herdr.dev) a herdr notification as well. Nothing else runs on its own.

**`[more]`, or `/nudge`,** opens the panel:

```
Cache ██████████████░░░░░░ 42m left
opus-5-5 · 120k tokens

Next message now: ~6k $0.02 · once cold: ~240k $0.96

Away for 4h (change the hours below)
▸ Keep warm    4 pings   ~24k    $0.10  ◂ cheapest
  Compact now            ~85k    $0.34
  Do nothing             ~234k   $0.94

Keep-warm stays cheaper than compacting for up to ~11.8h away.
```

Change the hours and the costs follow.

| Option | What it does |
| --- | --- |
| **Keep warm** (`[warm]` on the band: 4 hours) | A tiny hidden request every 50 minutes, read from the cache, which restarts its hour. Never shown in the conversation; it does not grow it. Stops at the hours you set, or with `/nudge off`. |
| **Then compact if I'm still away** | A toggle for keep-warm, off by default, per session. When keep-warm ends and you have not typed since its last ping, it compacts while the cache is still warm, so coming back costs only the summary. The band reads `warm 1h40m · 120k · then compact`. |
| **Ping once** | One such request: about an hour more. |
| **Write handoff** | Asks the session, in a visible turn and while the cache is warm, to write a handoff you can `/clear` from. |
| **Compact now** | Claude Code's own `/compact`. |

Keep-warm is usually the cheapest for absences of a few hours: each ping reads the conversation at the cache price, while letting it go cold rewrites all of it.

**Claude Code's idle compaction comes first on very large conversations.** From 200k tokens (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`) on a one-hour cache, Claude Code compacts an idle conversation by itself at minute 54, and a keep-warm ping does not postpone it. Above that size the band and the panel offer a handoff or a compaction instead of keep-warm, unless idle compaction or auto-compact is off.

A five-minute cache gets no nudge: it would fire at every pause.

## Settings

Environment variables, read when a session starts:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CACHE_NUDGE_REMIND_MIN` | `50` | Minutes idle before the nudge, 10 to 58 |
| `CACHE_NUDGE_COMPACT_AFTER_WARM` | off | `1` turns the then-compact toggle on in every new session |
| `CACHE_NUDGE_MIN_TOKENS` | the model's threshold | Nudge only from this context size |

## Install

Try it for one session:

```bash
git clone https://github.com/pelayomendez/claude-cache-nudge
claude --plugin-dir claude-cache-nudge
```

Every session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` of `~/.claude/settings.json`, or install it from this repository as a marketplace:

```
/plugin marketplace add pelayomendez/claude-cache-nudge
/plugin install cache-nudge@pelayomendez-cache-nudge
```

Requires Claude Code 2.1.287 or newer (plugin hooks modules).

## Develop

```bash
claude plugin validate .
claude plugin test .
```

## Credits

The cost model and the keep-warm request are adapted from [cache-panel](https://github.com/danyuchn/claude-mods/tree/main/cache-panel) by Dustin Yuchen Teng (MIT). The handling of Claude Code's idle compaction follows [cache-refresher](https://github.com/olddonkey/cache-refresher), and the handoff option was suggested by [claude-cache](https://github.com/the-cybersapien/claude-cache).

## License

MIT
