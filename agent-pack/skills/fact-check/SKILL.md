---
name: fact-check
description: Check a factual claim against PMBrain and its source pages when the user asks to verify, confirm, find evidence, or review facts before publication.
---

# Fact Check

1. Split the request into independently verifiable claims.
2. Use `recall` and `query` to find PMBrain evidence; use `get_page` to inspect original wording and context.
3. If the host provides external web search, use it only when current or external evidence is necessary. This Skill does not add web search to PMBrain.
4. Label each claim `verified`, `contradicted`, `uncertain`, `outdated`, or `unsupported` and cite the supporting page slugs.
5. Separate factual conflicts from subjective opinions and do not rewrite PMBrain during the check.
