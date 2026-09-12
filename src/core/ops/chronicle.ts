/**
 * Ontology operation cluster — transplanted from GBrain ops/chronicle.ts.
 * Chronicle timeline reads (day / on-this-day / since / last-seen) land in a
 * later PR; this module currently exports ONLY ontology_* ops.
 */

import type { Operation } from './contract.ts';
import { readPolicyOpts, sourceScopeOpts } from './context.ts';

const ontology_get: Operation = {
  name: 'ontology_get',
  description:
    "Life Chronicle: the current resolved per-entity ontology (dimension → value) at `asof` " +
    "(default now), with provenance + confidence + validity. CLI: `pmbrain ontology <entity> [--asof YYYY-MM-DD]`.",
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Valid-time as-of day YYYY-MM-DD (time-travel; default now).' },
    min_confidence: { type: 'number', description: 'Only return observations at/above this confidence (0..1).' },
    include_quarantined: { type: 'boolean', description: 'Include quarantined novel dimensions (default false).' },
  },
  handler: async (ctx, p) => {
    const rows = await ctx.engine.getOntology(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      includeQuarantined: p.include_quarantined === true,
      ...await readPolicyOpts(ctx),
    });
    // Remote redaction: never surface diary-sourced ontology to untrusted callers.
    return ctx.remote !== false ? rows.filter((r) => !(r.source ?? '').startsWith('life/diary/')) : rows;
  },
  cliHints: { name: 'ontology', positional: ['entity'] },
};

const ontology_propose: Operation = {
  name: 'ontology_propose',
  description:
    'Life Chronicle: record one ontology observation (entity has dimension=value), sourced + ' +
    'confidence-weighted + bi-temporal. Idempotent on (entity,dimension,value,source). A new value ' +
    'supersedes the prior; a backdated conflict is flagged not rewritten. CLI: `pmbrain ontology-add <entity> <dimension> <value>`.',
  scope: 'write',
  mutating: true,
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug.' },
    dimension: { type: 'string', required: true, description: 'Dimension (e.g. role, risk_tolerance, 职位). Normalized at write.' },
    value: { type: 'string', required: true, description: 'The resolved value (e.g. advisor).' },
    confidence: { type: 'number', description: '0..1; default 0.7.' },
    source: { type: 'string', description: 'Provenance (page slug / uri); default "manual".' },
    valid_from: { type: 'string', description: 'ISO date the value became true (default: now).' },
    valid_to: { type: 'string', description: 'ISO date the value stopped being true (default: open).' },
    visibility: { type: 'string', enum: ['private', 'world'], description: 'Default private.' },
  },
  handler: async (ctx, p) => {
    // [ENG-8] Same unset-vs-explicit ladder as extract_facts: explicit
    // caller visibility wins; unset resolves facts.default_visibility.
    const { resolveVisibilityParam } = await import('../facts/visibility.ts');
    return ctx.engine.mergeOntologyFact({
      entitySlug: String(p.entity),
      dimension: String(p.dimension),
      value: String(p.value),
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
      source: typeof p.source === 'string' && p.source ? p.source : 'manual',
      validFrom: typeof p.valid_from === 'string' ? p.valid_from : undefined,
      validTo: typeof p.valid_to === 'string' ? p.valid_to : undefined,
      visibility: await resolveVisibilityParam(ctx.engine, p.visibility),
      sourceId: ctx.sourceId,
    });
  },
  cliHints: { name: 'ontology-add', positional: ['entity', 'dimension', 'value'] },
};

const ontology_dimensions: Operation = {
  name: 'ontology_dimensions',
  description:
    'Life Chronicle meta-ontology: which dimensions the brain tracks across entities, with ' +
    'entity + observation counts. CLI: `pmbrain ontology-dimensions`.',
  scope: 'read',
  params: {},
  handler: async (ctx) => ctx.engine.discoverOntologyDimensions(sourceScopeOpts(ctx)),
  cliHints: { name: 'ontology-dimensions' },
};

const ontology_conflicts: Operation = {
  name: 'ontology_conflicts',
  description:
    'Life Chronicle: dimensions with ≥2 distinct current values from ≥2 provenances (genuine ' +
    'disagreement, not temporal supersession). CLI: `pmbrain ontology-contradictions`.',
  scope: 'read',
  params: {
    min_confidence: { type: 'number', description: 'Only consider observations at/above this confidence (0..1).' },
  },
  handler: async (ctx, p) => {
    const conflicts = await ctx.engine.findOntologyConflicts({
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      ...await readPolicyOpts(ctx),
    });
    if (ctx.remote === false) return conflicts;
    // Remote: redact diary-sourced values; drop conflicts that no longer have
    // ≥2 distinct values once diary provenance is removed (no leak via conflicts).
    return conflicts
      .map((c) => ({ ...c, values: c.values.filter((v) => !(v.source ?? '').startsWith('life/diary/')) }))
      .filter((c) => new Set(c.values.map((v) => v.value)).size >= 2);
  },
  cliHints: { name: 'ontology-contradictions' },
};

export const chronicleOperations: Operation[] = [
  ontology_get, ontology_propose, ontology_dimensions, ontology_conflicts,
];
