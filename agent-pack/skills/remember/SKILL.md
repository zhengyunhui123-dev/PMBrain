---
name: remember
description: Save durable knowledge when the user says to remember, save, preserve, follow in future, or treat something as an important preference.
---

# Remember

1. Use `recall` to find an existing fact before writing.
2. Save only facts, preferences, decisions, or commitments the user actually stated. Never turn an AI guess into a user fact.
3. Call PMBrain `remember` once per claim with `fact`, `provenance`, and a suitable `kind`. Use `ttl` only for temporary information.
4. Do not use `put_page` as a memory store.
5. After a successful `remember`, stop. Do not copy the same fact into another agent memory.
