---
name: durable-writeback
description: Persist clearly established long-lived decisions, preferences, commitments, project-status changes, or important fact corrections discovered during the current task.
---

# Durable Writeback

1. Write back only information that is explicit, important, and likely to matter later.
2. Exclude ordinary chat, transient debugging state, speculation, and unconfirmed judgments.
3. Search with `recall` and `query`, then read the target with `get_page` to avoid duplicate or conflicting pages.
4. Use `put_page` through the canonical write path and preserve existing frontmatter, links, and unrelated content.
5. Verify the result with `get_page` and report exactly what became durable.
