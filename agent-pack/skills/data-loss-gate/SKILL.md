---
name: data-loss-gate
description: Gate bulk deletion, purge, forgetting, source removal, bulk overwrite, and large replacement requests that could remove or corrupt PMBrain knowledge.
---

# Data Loss Gate

1. Inspect the exact scope with read operations such as `list_pages`, `get_page`, and `sources_list`.
2. Explain what will change, how many records or sources are affected, and whether recovery is available.
3. Wait for explicit user confirmation naming the intended scope before invoking `delete_page`, `forget_fact`, `sources_remove`, or any destructive admin workflow.
4. Prefer recoverable soft deletion where available.
5. Never weaken or bypass PMBrain write policy, OAuth scope, source scope, backups, or underlying permission checks.
