---
name: durable-writeback
description: Persist clearly established long-lived decisions, preferences, commitments, project-status changes, or important fact corrections discovered during the current task.
---

# Durable Writeback

1. Use this path only when MCP initialize instructions include Ambient memory writeback. If that section is absent, do not write Facts unprompted.
2. Write back only information that is explicit, important, and likely to matter later.
3. Exclude ordinary chat, transient debugging state, speculation, and unconfirmed judgments.
4. Search with `recall` to avoid duplicates, then call `remember` once per claim. Do not use `put_page` as a memory store and do not invent a `hook:writeback` Source.
5. Save silently unless the user asks whether it was remembered.
