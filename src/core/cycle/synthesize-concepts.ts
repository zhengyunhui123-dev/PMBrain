// v0.41 T6 — synthesize_concepts cycle phase (minimal-viable implementation).
//
// v0.41 ships a working concept synthesis path: group atoms by simple
// frontmatter tag/concept references, tier by count (T1 ≥10, T2 ≥5,
// T3 ≥2, T4 ≥1), Sonnet-synthesize T1/T2 narratives. Voice gate
// integration + dedup-by-embedding-similarity ship in v0.42+.
//
// Sequencing:
//   1. Query all atom-typed pages from DB (excluding imported_from
//      marker → atoms already extracted by your OpenClaw don't get
//      re-synthesized as concepts here; their original concept pages
//      come through greenfield import already).
//   2. Group by `concepts:` frontmatter field on each atom (when the
//      Haiku 3-check from extract_atoms decides "this atom is about
//      concept X", it stamps the field).
//   3. For each group with count ≥2: assign tier (T1/T2/T3/T4 by count).
//   4. For T1/T2 groups: Sonnet call to produce a 1-paragraph narrative.
//      For T3/T4: deterministic stub narrative.
//   5. Write concept-typed pages.

import type { BrainEngine } from '../engine.ts';
import { createHash } from 'node:crypto';
import { readPhaseBudget } from './phase-budget.ts';
import { BudgetTracker, BudgetExhausted, loadPricingOverrides } from '../budget/budget-tracker.ts';
import type { PhaseResult } from '../cycle.ts';
import type { ProgressReporter } from '../progress.ts';
import { writeReceipt } from '../extract/receipt-writer.ts';
import { throwIfAborted } from '../abort-check.ts';
import { upsertExtractRollup } from '../extract/rollup-writer.ts';
import { chat as gatewayChat, isAvailable } from '../ai/gateway.ts';
import { importFromContent } from '../import-file.ts';
import { serializeMarkdown } from '../markdown.ts';
import { dreamModelDetails, resolveDreamModel } from './model-routing.ts';

const DEFAULT_BUDGET_USD = 1.5;
const TIER_T1_MIN = 10;
const TIER_T2_MIN = 5;
const TIER_T3_MIN = 2;

export interface SynthesizeConceptsOpts {
  brainDir?: string;
  /** Explicit cycle Source. When omitted, preserve the legacy global/default behavior. */
  sourceId?: string;
  dryRun?: boolean;
  yieldDuringPhase?: (() => Promise<void>) | undefined;
  /**
   * v0.41.19.0 (T4): progress reporter for in-phase ticks. Cycle.ts
   * passes the SAME reporter (not a child — see extract-atoms.ts for
   * the path-collision bug codex caught). Phases only call `tick()` /
   * `heartbeat()`; cycle.ts owns start/finish.
   */
  progress?: ProgressReporter;
  /** Cooperative stop from the owning Dream job. */
  signal?: AbortSignal;
  deferEmbedding?:boolean;
  since?:string;
  /** Test seam: alternative chat function. */
  _chat?: typeof gatewayChat;
  /** Test seam: skip DB query; cluster these atoms directly. */
  _atoms?: Array<{ slug: string; source_id?: string; concept_refs: string[]; body: string; title: string }>;
}

interface AtomGroup {
  conceptSlug: string;
  atomTitles: string[];
  atomBodies: string[];
  atomRefs: Array<{ slug: string; source_id: string }>;
  tier: 'T1' | 'T2' | 'T3' | 'T4';
}

const SYNTH_PROMPT = `You write a 1-paragraph executive summary of a concept
based on multiple atom-shaped insights that reference it.

Output ONLY the summary paragraph (3-5 sentences). No headers, no JSON,
no preamble. Use the language of the source evidence. Synthesize what
the atoms collectively SAY about the concept; don't enumerate the atoms.`;

export async function runPhaseSynthesizeConcepts(
  engine: BrainEngine,
  opts: SynthesizeConceptsOpts = {},
): Promise<PhaseResult> {
  throwIfAborted(opts.signal, '[dream] synthesize_concepts');
  const chat = opts._chat ?? gatewayChat;
  const resolvedModel = await resolveDreamModel(engine, { phase: 'synthesize_concepts' });
  const modelDetails = dreamModelDetails(resolvedModel, 'single_chat');
  const evidenceSnapshots=new Map<string,string>();
  const touchedConcepts=new Set<string>();

  // 1. Get atom pages (test seam OR DB query)
  let atoms = opts._atoms ?? [];
  if (atoms.length === 0 && opts._atoms === undefined) {
    try {
      const rows = await engine.executeRaw<{
        slug: string;
        source_id: string;
        title: string;
        compiled_truth: string;
        frontmatter: { concepts?: string[]; imported_from?: string };
        id:number;
        knowledge_revision:string;
        updated_at:string|Date;
      }>(
        `SELECT id, knowledge_revision, updated_at, slug, source_id, title, compiled_truth, frontmatter
           FROM pages
          WHERE type = 'atom'
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL
            AND COALESCE(frontmatter->>'visibility','world')<>'private' AND COALESCE(frontmatter->>'private','false')<>'true'
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id=pages.source_id AND s.archived=false)
            AND (frontmatter->>'source_slug' IS NULL OR EXISTS (
              SELECT 1 FROM pages origin WHERE origin.source_id=pages.source_id AND origin.slug=pages.frontmatter->>'source_slug'
                AND origin.deleted_at IS NULL AND COALESCE(origin.frontmatter->>'visibility','world')<>'private'
                AND COALESCE(origin.frontmatter->>'private','false')<>'true'
                AND (pages.frontmatter->>'source_hash' IS NULL OR substring(origin.content_hash from 1 for 16)=pages.frontmatter->>'source_hash')
            ))
            AND ($1::text IS NULL OR source_id = $1)`,
        [opts.sourceId ?? null],
      );
      for(const row of rows)evidenceSnapshots.set(`${row.source_id}:${row.slug}`,JSON.stringify([row.id,row.knowledge_revision,row.title,row.compiled_truth,row.frontmatter]));
      for(const row of rows)if(!opts.since||new Date(row.updated_at).getTime()>=Date.parse(opts.since))for(const concept of Array.isArray(row.frontmatter.concepts)?row.frontmatter.concepts:[])touchedConcepts.add(concept);
      atoms = rows
        .filter((r) => Array.isArray(r.frontmatter?.concepts) && r.frontmatter.concepts.length > 0)
        .map((r) => ({
          slug: r.slug,
          source_id: r.source_id,
          title: r.title,
          body: r.compiled_truth,
          concept_refs: r.frontmatter!.concepts!,
        }));
    } catch(error) {
      throw error;
    }
  }

  if (atoms.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: 'synthesize_concepts: no atoms with concept refs',
      details: { ...modelDetails, reason: 'no_atoms' },
    };
  }

  // 2. Group atoms by concept slug
  const groups = new Map<string, {
    titles: string[];
    bodies: string[];
    refs: Array<{ slug: string; source_id: string }>;
  }>();
  for (const atom of atoms) {
    for (const conceptSlug of atom.concept_refs) {
      const existing = groups.get(conceptSlug) ?? { titles: [], bodies: [], refs: [] };
      existing.titles.push(atom.title);
      existing.bodies.push(atom.body);
      existing.refs.push({ slug: atom.slug, source_id: atom.source_id ?? 'default' });
      groups.set(conceptSlug, existing);
    }
  }

  // 3. Filter to count ≥2, assign tier
  const atomGroups: AtomGroup[] = [];
  for (const [conceptSlug, data] of groups) {
    if(opts.since&&opts._atoms===undefined&&!touchedConcepts.has(conceptSlug))continue;
    const count = data.titles.length;
    if (count < TIER_T3_MIN) continue;
    const tier: AtomGroup['tier'] =
      count >= TIER_T1_MIN ? 'T1' : count >= TIER_T2_MIN ? 'T2' : 'T3';
    atomGroups.push({
      conceptSlug,
      atomTitles: data.titles,
      atomBodies: data.bodies,
      atomRefs: data.refs,
      tier,
    });
  }

  if (atomGroups.length === 0) {
    return {
      phase: 'synthesize_concepts',
      status: 'skipped',
      duration_ms: 0,
      summary: `synthesize_concepts: no concept groups with ≥${TIER_T3_MIN} atoms`,
      details: { ...modelDetails, reason: 'no_groups_above_threshold', atoms_seen: atoms.length },
    };
  }

  // 4. Per group: synthesize narrative (LLM for T1/T2, deterministic for T3+)
  let conceptsWritten = 0;
  const conceptSlugs: string[] = [];
  let estimatedSpendUsd = 0;
  const budgetCap = await readPhaseBudget(engine,'cycle.synthesize_concepts.budget_usd',DEFAULT_BUDGET_USD);
  const failures: Array<{ concept: string; error: string }> = [];
  const tierCounts = { T1: 0, T2: 0, T3: 0, T4: 0 };
  let cachedConcepts=0;
  let llmConcepts=0,deterministicConcepts=0,deferredConcepts=0;
  const budgetTracker=new BudgetTracker({maxCostUsd:budgetCap,label:'cycle.synthesize_concepts',pricingOverrides:await loadPricingOverrides(engine)});

  // v0.41.19.0 (T3): throttled yield helper. Fires `opts.yieldDuringPhase`
  // every 30s — cycle.ts threads `buildYieldDuringPhase(lock, outer)` so
  // each fire refreshes the cycle DB lock + the existing external hook.
  // Pre-v0.41.19 the bare `if (opts.yieldDuringPhase) await ...()` at
  // every iteration fired hundreds of times per phase; the 30s throttle
  // matches the actual lock-refresh budget.
  let lastYieldMs = Date.now();
  async function maybeYield(): Promise<void> {
    if (!opts.yieldDuringPhase) return;
    const now = Date.now();
    if (now - lastYieldMs < 30_000) return;
    lastYieldMs = now;
    try {
      await opts.yieldDuringPhase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[synthesize_concepts] yieldDuringPhase failed (non-fatal): ${msg}`);
    }
  }

  for (const group of atomGroups) {
    throwIfAborted(opts.signal, '[dream] synthesize_concepts');
    const title=group.conceptSlug.split('/').pop()??group.conceptSlug;
    const outputSlug=`concepts/${title}`;
    const outputSourceId=opts.sourceId??'default';
    const baseline=await engine.getPage(outputSlug,{sourceId:outputSourceId});
    const membersHash=createHash('sha256').update(JSON.stringify(['dream-concept-v1',group.tier,group.atomRefs.map((ref,i)=>[ref.source_id,ref.slug,group.atomTitles[i],group.atomBodies[i]]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])).digest('hex');
    if(baseline?.frontmatter.pmbrain_concept_members_hash===membersHash&&baseline.frontmatter.pmbrain_concept_complete!==false){cachedConcepts++;continue;}
    tierCounts[group.tier]++;
    let narrative: string;
    let complete=true;
    if (group.tier === 'T1' || group.tier === 'T2') {
      if (estimatedSpendUsd >= budgetCap) {
        narrative = deterministicNarrative(group);
        complete=false;deferredConcepts++;
      } else {
        try {
          budgetTracker.reserve({modelId:resolvedModel.model,estimatedInputTokens:Math.ceil(group.atomBodies.slice(0,5).join('').length/3)+300,maxOutputTokens:500,kind:'chat'});
          const result = await chat({
            model: resolvedModel.model,
            system: SYNTH_PROMPT,
            messages: [
              {
                role: 'user',
                content:
                  `Concept slug: ${group.conceptSlug}\n` +
                  `${group.atomTitles.length} atoms reference this concept.\n\n` +
                  `Sample atom titles:\n${group.atomTitles.slice(0, 10).map((t) => `  - ${t}`).join('\n')}\n\n` +
                  `Sample atom bodies:\n${group.atomBodies
                    .slice(0, 5)
                    .map((b, i) => `${i + 1}. ${b.slice(0, 500)}`)
                    .join('\n\n')}`,
              },
            ],
            maxTokens: 500,
            abortSignal: opts.signal,
          });
          // Post-await yield (T3): the LLM call is the main TTL hazard
          // codex flagged. Throttle inside maybeYield bounds the actual
          // refresh rate.
          await maybeYield();
          budgetTracker.record({modelId:result.model??resolvedModel.model,inputTokens:result.usage.input_tokens,outputTokens:result.usage.output_tokens});
          estimatedSpendUsd=budgetTracker.totalSpent;
          narrative = result.text.trim() || deterministicNarrative(group);
          if(result.text.trim())llmConcepts++;else{complete=false;failures.push({concept:group.conceptSlug,error:'empty_concept_response'});}
        } catch (err) {
          throwIfAborted(opts.signal, '[dream] synthesize_concepts');
          complete=false;
          if(err instanceof BudgetExhausted)deferredConcepts++;
          else failures.push({
            concept: group.conceptSlug,
            error: err instanceof Error ? err.message : String(err),
          });
          narrative = deterministicNarrative(group);
        }
      }
    } else {
      narrative = deterministicNarrative(group);
      deterministicConcepts++;
    }

    if (!opts.dryRun) {
      const section='\n\n## 知识综合\n\n';
      const previousNarrative=baseline?.frontmatter.pmbrain_concept_narrative;
      let original=baseline?.compiled_truth??'';
      if(typeof previousNarrative==='string'){
        if(original===previousNarrative)original='';
        else if(original.endsWith(section+previousNarrative))original=original.slice(0,-(section+previousNarrative).length);
        else{failures.push({concept:group.conceptSlug,error:'concept_preservation_hold: generated section was edited; existing page preserved'});continue;}
      }
      const compiled=original?original+section+narrative:narrative;
      // Concept pages are user-facing Dream output and must participate in
      // the same chunk/search pipeline as imported knowledge. A bare putPage
      // only wrote the pages row, so reuse the canonical import path while
      // retaining the existing global-source and relationship semantics.
      const markdown = serializeMarkdown(
        {
          ...baseline?.frontmatter,
          ...(!baseline?{dream_generated:true}:{}),
          tier: group.tier,
          mention_count: group.atomTitles.length,
          composite_score: group.atomTitles.length,
          synthesized_at: new Date().toISOString(),
          synthesized_by: 'synthesize_concepts-v0.41',
          pmbrain_concept_members_hash:membersHash,
          pmbrain_concept_narrative:narrative,
          pmbrain_concept_complete:complete,
          derives_from: group.atomRefs.map(ref => ({
            slug: ref.slug,
            source_id: ref.source_id,
          })),
        },
        compiled,
        baseline?.timeline??'',
        { type: 'concept', title: baseline?.title??title.replace(/-/g, ' '), tags: baseline?await engine.getTags(outputSlug,{sourceId:outputSourceId}):[] },
      );
      await engine.transaction(async tx=>{
      for(const ref of group.atomRefs){
        const snapshot=evidenceSnapshots.get(`${ref.source_id}:${ref.slug}`);
        if(snapshot===undefined)continue;
        const [currentAtom]=await tx.executeRaw<{id:number;knowledge_revision:string;title:string;compiled_truth:string;frontmatter:unknown}>("SELECT id,knowledge_revision,title,compiled_truth,frontmatter FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL FOR SHARE",[ref.source_id,ref.slug]);
        if(!currentAtom||JSON.stringify([currentAtom.id,currentAtom.knowledge_revision,currentAtom.title,currentAtom.compiled_truth,currentAtom.frontmatter])!==snapshot)throw new Error('concept_evidence_conflict: atom changed during synthesis');
      }
      await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE',[outputSourceId,outputSlug]);
      const current=await tx.getPage(outputSlug,{sourceId:outputSourceId});
      if(JSON.stringify(current&&[current.compiled_truth,current.timeline,current.frontmatter])!==JSON.stringify(baseline&&[baseline.compiled_truth,baseline.timeline,baseline.frontmatter]))throw new Error('concept_revision_conflict: page changed during synthesis');
      await importFromContent(tx, outputSlug, markdown, {
        noEmbed: opts.deferEmbedding||!isAvailable('embedding'),
        sourceId: outputSourceId,
      });
      const relationshipRows = group.atomRefs.flatMap(ref => [
        {
          from_slug: outputSlug,
          to_slug: ref.slug,
          link_type: 'derives_from',
          context: `Dream concept synthesis: ${outputSlug} derives from ${ref.slug}`,
          link_source: 'frontmatter',
          origin_slug: outputSlug,
          origin_field: 'derives_from',
          from_source_id: outputSourceId,
          to_source_id: ref.source_id,
          origin_source_id: outputSourceId,
          resolution_type: 'qualified' as const,
        },
        {
          from_slug: ref.slug,
          to_slug: outputSlug,
          link_type: 'evidence_of',
          context: `Dream concept evidence: ${ref.slug} supports ${outputSlug}`,
          link_source: 'frontmatter',
          origin_slug: outputSlug,
          origin_field: 'derives_from',
          from_source_id: ref.source_id,
          to_source_id: outputSourceId,
          origin_source_id: outputSourceId,
          resolution_type: 'qualified' as const,
        },
      ]);
      const provenanceLinks = group.atomRefs.flatMap(ref => [
        {
          from_slug: outputSlug,
          to_slug: ref.slug,
          link_type: 'synthesized_from',
          context: 'member atom',
          link_source: 'concept-provenance',
          from_source_id: outputSourceId,
          to_source_id: ref.source_id,
        },
        {
          from_slug: ref.slug,
          to_slug: outputSlug,
          link_type: 'synthesizes',
          context: 'concept synthesized from this atom',
          link_source: 'concept-provenance',
          from_source_id: ref.source_id,
          to_source_id: outputSourceId,
        },
      ]);
      await tx.addLinksBatch(relationshipRows, { auditSite: 'extract.links_db' }); // gbrain-allow-direct-insert: Dream concept evidence is written inside the cycle reconcile path.
        await tx.addLinksBatch(provenanceLinks, { auditSite: 'cycle.synthesize_concepts.provenance' }); // gbrain-allow-direct-insert: Dream concept provenance is written inside the cycle reconcile path.
      });
      conceptSlugs.push(outputSlug);
    }
    conceptsWritten++;
    // v0.41.19.0 (T4): one tick per concept group with running count.
    opts.progress?.tick(1, `${conceptsWritten} concepts`);

    // v0.41.19.0 (T3): replaced bare per-iteration fire with throttled
    // helper. Same hook, same cycle-lock refresh effect, just at the
    // right cadence (30s instead of every-group).
    await maybeYield();
  }

  // v0.42 Wave B3: receipt + rollup for synthesize_concepts. Brain-global
  // phase — uses 'default' source_id because concepts span sources. Receipt
  // only fires when concepts were actually written; rollup always fires so
  // doctor sees the phase ran.
  if (!opts.dryRun && conceptsWritten > 0) {
    const runId = `concepts-${Date.now().toString(36)}`;
    try {
      await writeReceipt(engine, {
        kind: 'concepts',
        source_id: opts.sourceId ?? 'default',
        run_id: runId,
        round: 'single',
        extracted_at: new Date().toISOString(),
        total_rows: conceptsWritten,
        cost_usd: estimatedSpendUsd,
        summary:
          `Synthesized ${conceptsWritten} concepts ` +
          `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3}) ` +
          `from ${atomGroups.length} groups across ${atoms.length} atoms.`,
      });
    } catch (err) {
      console.error(`[synthesize_concepts] receipt write failed: ${(err as Error).message}`);
    }
  }
  if (!opts.dryRun) {
    await upsertExtractRollup(engine, {
      kind: 'concepts',
      source_id: opts.sourceId ?? 'default',
      cost_delta: estimatedSpendUsd,
      round_completed_delta: failures.length === 0 ? 1 : 0,
      halt_delta: failures.length > 0 ? 1 : 0,
    });
  }

  return {
    phase: 'synthesize_concepts',
    status: failures.length > 0||deferredConcepts>0 ? 'warn' : 'ok',
    duration_ms: 0,
    summary:
      `synthesize_concepts: ${conceptsWritten} concepts ` +
      `(T1=${tierCounts.T1} T2=${tierCounts.T2} T3=${tierCounts.T3})` +
      (failures.length > 0 ? ` (${failures.length} LLM-failed → template fallback)` : ''),
    details: {
      ...modelDetails,
      concepts_written: conceptsWritten,
      concepts_cached:cachedConcepts,
      concepts_llm:llmConcepts,
      concepts_deterministic:deterministicConcepts,
      concepts_remaining:deferredConcepts+failures.filter(row=>!row.error.includes('budget')).length,
      concept_slugs: conceptSlugs,
      tier_counts: tierCounts,
      groups_found: atomGroups.length,
      atoms_seen: atoms.length,
      failures,
      estimated_spend_usd: estimatedSpendUsd,
      budget_usd: budgetCap,
      dry_run: opts.dryRun ?? false,
    },
  };
}

/**
 * Deterministic fallback narrative for T3/T4 concepts and budget-exhausted
 * T1/T2 groups. No LLM call. v0.41 minimal shape — v0.42 enriches with
 * dominant themes, time spread, breadth.
 */
function deterministicNarrative(group: AtomGroup): string {
  const tier = group.tier;
  const count = group.atomTitles.length;
  return (
    `${tier} concept. ${count} atom${count === 1 ? '' : 's'} reference this. ` +
    `Top mentions:\n${group.atomTitles
      .slice(0, 5)
      .map((t) => `  - ${t}`)
      .join('\n')}`
  );
}
