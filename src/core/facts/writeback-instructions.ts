export interface AmbientWritebackOpts {
  mode: 'salient' | 'all';
  transientTtl: string;
  visibility: 'world' | 'private';
  extractFactsAvailable: boolean | 'unknown';
}

export function buildAmbientWritebackSection(opts: AmbientWritebackOpts): string {
  const candidatePolicy = opts.mode === 'salient'
    ? 'Save the durable, notable ones: preferences, corrections, decisions, commitments, relationships, and project-state changes.'
    : 'Save every direct factual statement the user makes — still excluding operational chatter, assistant-generated content, secrets or credentials, and quoted third-party material.';
  const multiFact = opts.extractFactsAvailable === true
    ? 'For a raw turn carrying several facts, submit the turn text once through extract_facts instead of many remember calls.'
    : opts.extractFactsAvailable === 'unknown'
      ? 'For a raw turn carrying several facts, submit the turn text once through extract_facts when that tool is in your tool list; otherwise distill them yourself and call remember once per claim.'
      : 'When a turn carries several facts, distill them yourself and call remember once per claim.';
  const transientLine = opts.extractFactsAvailable === false
    ? `pass ttl: "${opts.transientTtl}".`
    : `always save via remember with ttl: "${opts.transientTtl}" — never batch them through extract_facts (it cannot set a ttl, so they would become permanent).`;
  const visibilityLine = opts.visibility === 'world'
    ? 'Pass visibility: "world" explicitly on every save. "world" means readable by agents authorized on THIS brain — not the public internet. Never widen a private fact on your own.'
    : 'Pass visibility: "private" explicitly on every save — this brain\'s operator keeps facts private by default (omitting visibility would silently widen: remember defaults to world). Private facts are readable by the local CLI only, not by remote sessions. Never widen to world on your own.';
  return `Ambient memory writeback (enabled by this brain's operator — mode: ${opts.mode}):
1. Treat every substantive statement the user makes about themselves, their people, projects, or plans as a memory candidate. ${candidatePolicy}
2. Save with remember: ONE claim per call; set kind (event | preference | commitment | belief | fact) and set entity whenever a person, company, or project is the subject.
3. ${multiFact}
4. Include concise provenance on every save: harness name, session or thread id when available, and the date.
5. Durable facts (preferences, corrections, decisions, commitments, relationships, project state): omit ttl — they never expire.
6. Transient facts (current health, location, travel, mood, near-term schedule): ${transientLine}
7. Skip: greetings, acknowledgements, questions that carry no new facts, tool output, quoted third-party material, and pasted or imported text — unless the user explicitly asks you to remember it.
8. Never store your own inference, diagnosis, speculation, or interpretation as a user fact. Never store raw transcripts, secrets, passwords, or credentials.
9. ${visibilityLine}
10. Stay within the authenticated brain and Source scope; write nowhere else. Do not invent a Source named hook:writeback.
11. Write silently — no routine "saved to memory" receipts; mention memory only when the user asks.`;
}
