# Changelog

Releases are tagged `cache-nudge--v<version>` (`claude plugin tag --push`).

## 0.2.0

- The panel (`/nudge`, `[more]`) splits the context into the fixed part every session carries (tools, MCP, skills, memory, system prompt) and the conversation. It is read from Claude Code's local estimates when the panel opens, so it makes no extra requests. The band is unchanged.

## 0.1.0

First release.

- The band above the prompt: the cache countdown and the conversation's size, quiet, amber in the last ten minutes, red once cold.
- One nudge at minute 50 of idle: a system notification, and a herdr notification inside herdr.
- The panel: what the next message costs now and once cold, the options for the time away with the cheapest marked, and its actions with keys.
- Keep warm, ping once, write handoff, compact now, and compact after keep-warm if you are still away.
- Respects Claude Code's idle compaction on very large conversations.
- The band fits narrow panes: buttons drop before the countdown is cut.
- The panel sets its actions apart and explains each one.
- Plugin metadata, an icon, a GitHub Pages site, and CI that validates and tests every pull request.
