---
name: takes-review
description: Review pending PMBrain take proposals when the user asks for new viewpoints, pending viewpoints, items needing confirmation, or a viewpoint review.
---

# Takes Review

1. Call `list_take_proposals` with `status=pending` and show 5 to 10 concise numbered proposals.
2. Wait for the user's explicit decision. Never decide that a proposal is correct or accept it autonomously.
3. When the user asks for evidence, call `get_take_proposal` and show the source context, staleness, and possible duplicates.
4. On explicit acceptance, call `accept_take_proposal`. Pass `edited_claim`, `edited_kind`, `edited_holder`, `edited_weight`, or `edited_domain` only when the user supplied or approved those edits.
5. On explicit rejection, call `reject_take_proposal` and record the user's reason when available.
6. If a proposal is stale, stop acceptance and show the current evidence for a fresh decision.
