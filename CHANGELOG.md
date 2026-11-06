# Changelog

Releases are tagged `cache-nudge--v<version>` (`claude plugin tag --push`).

## Unreleased

- The band fits narrow panes: buttons drop before the countdown is cut.
- The panel sets its actions apart and explains each one.
- Plugin metadata, an icon, a GitHub Pages site, and CI that validates and tests every pull request.

## 0.1.0

- The band above the prompt: the cache countdown and the conversation's size, quiet, amber in the last ten minutes, red once cold.
- One nudge at minute 50 of idle: a system notification, and a herdr notification inside herdr.
- The panel: what the next message costs now and once cold, the options for the time away with the cheapest marked, and its actions with keys.
- Keep warm, ping once, write handoff, compact now, and compact after keep-warm if you are still away.
- Respects Claude Code's idle compaction on very large conversations.
