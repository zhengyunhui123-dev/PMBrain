---
name: conversation-summary
description: Summarize and save the current conversation when the user explicitly asks to preserve the discussion or turn it into durable PMBrain knowledge.
---

# Conversation Summary

1. Extract decisions, conclusions, preferences, commitments, action items, unresolved questions, and important fact changes from the current conversation.
2. Do not store the full transcript or incidental chat.
3. Use `recall` and `query` to find the relevant existing pages, then load targets with `get_page`.
4. Merge the durable summary into the appropriate canonical pages with `put_page`; avoid a duplicate catch-all page when an entity page exists.
5. Verify every changed page with `get_page` and tell the user what was saved.
