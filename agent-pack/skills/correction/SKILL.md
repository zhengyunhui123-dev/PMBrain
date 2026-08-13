---
name: correction
description: Investigate and safely correct PMBrain knowledge when the user says it is wrong, outdated, misattributed, duplicated, unsupported, or should say something else.
---

# Correction

1. Identify the disputed claim with `recall` and `query`, then load the exact page using `get_page`.
2. Inspect `get_links` and `get_backlinks` when the error may have propagated or crossed entities.
3. Classify the cause as source error, extraction error, stale information, duplicate, entity cross-contamination, or unsupported inference.
4. Explain the evidence found before changing it.
5. For one clear, low-risk excerpt, use `patch_page` with exact `old_text`, the corrected `new_text`, and a concrete `reason`.
6. Ask for explicit confirmation before destructive, broad, or ambiguous changes. Never use a patch to bypass deletion safeguards.
7. Re-run `get_page` and a relevant query after the change; check obvious linked pages for remaining contamination.
