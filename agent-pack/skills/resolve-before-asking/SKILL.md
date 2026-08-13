---
name: resolve-before-asking
description: Resolve ambiguous references from PMBrain before asking the user, such as a person's nickname, an unnamed project, or an implied historical event.
---

# Resolve Before Asking

1. Use `recall`, then `query`, to identify likely entities or projects.
2. Load promising pages with `get_page`.
3. Use `get_links` and `get_backlinks` to disambiguate relationships and context.
4. Ask the user only if material ambiguity remains. State the candidates and the exact choice needed instead of asking them to repeat known context.
5. Do not guess when multiple candidates remain plausible.
