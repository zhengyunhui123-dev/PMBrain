import type { SearchResult } from '../types.ts';
import type { ModalityMode } from './query-intent.ts';

export type MetadataBoostGate = 'always' | 'lexical';

export const METADATA_BOOST_GATES: ReadonlyArray<MetadataBoostGate> = Object.freeze(['always', 'lexical']);

export const DEFAULT_METADATA_BOOST_GATE: MetadataBoostGate = 'always';

export type MetadataBoostGateReason =
  | 'gate_always'
  | 'lexical_voted'
  | 'vector_only_voter'
  | 'image_modality';

export interface MetadataBoostGateDecision {
  gate: MetadataBoostGate;
  lexical_voted: boolean;
  boosts_applied: boolean;
  reason: MetadataBoostGateReason;
}

export function normalizeMetadataBoostGate(v: unknown): MetadataBoostGate | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return (METADATA_BOOST_GATES as ReadonlyArray<string>).includes(s) ? (s as MetadataBoostGate) : undefined;
}

export interface LexicalArmsVotedInput {
  keywordFusionList: ReadonlyArray<SearchResult>;
  titleFusionList: ReadonlyArray<SearchResult>;
  relationalList: ReadonlyArray<SearchResult>;
  includeRelational: boolean;
}

export function lexicalArmsVoted(input: LexicalArmsVotedInput): boolean {
  return (
    input.keywordFusionList.length > 0
    || input.titleFusionList.length > 0
    || (input.includeRelational && input.relationalList.length > 0)
  );
}

export function decideMetadataBoosts(input: {
  gate: MetadataBoostGate;
  lexicalVoted: boolean;
  modality?: ModalityMode;
}): MetadataBoostGateDecision {
  const { gate, lexicalVoted, modality } = input;
  if (gate === 'always') {
    return { gate, lexical_voted: lexicalVoted, boosts_applied: true, reason: 'gate_always' };
  }
  if (modality === 'image') {
    return { gate, lexical_voted: lexicalVoted, boosts_applied: true, reason: 'image_modality' };
  }
  return lexicalVoted
    ? { gate, lexical_voted: true, boosts_applied: true, reason: 'lexical_voted' }
    : { gate, lexical_voted: false, boosts_applied: false, reason: 'vector_only_voter' };
}
