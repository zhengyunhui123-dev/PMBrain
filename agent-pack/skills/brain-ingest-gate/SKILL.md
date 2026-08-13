---
name: brain-ingest-gate
description: Quality-check candidate knowledge before an agent writes it into PMBrain, especially when deciding whether to create or update a durable page.
---

# Brain Ingest Gate

Before writing, determine whether the information is durable, already present, tied to the correct entity, sourced, and free of unsupported AI inference. Use `recall` and `query` for duplicates, then `get_page` for the intended target. Prefer updating an existing page. Use the existing `put_page` canonical writer only after the gate passes, and verify the page afterward. Do not invent a second organization or ingestion system.
