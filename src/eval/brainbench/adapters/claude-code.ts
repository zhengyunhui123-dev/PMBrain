/**
 * BrainBench Claude Code adapter — seam: 'contract' on PMBrain.
 *
 * GBrain 0.48.5.0 drives the shipped UserPromptSubmit hook over resolve-IPC
 * (`gbrain hook user-prompt` + assembleTurnContext). PMBrain's hook surface
 * is writeback-only (stop / session-end), so this row grades the same
 * reflex + volunteer primitives under a 2-pointer contract budget with
 * prior-injection suppression. Cross-turn dedupe is adapter-owned: each
 * injection is appended to a run-local prior-context buffer.
 */

import type { PGLiteEngine } from '../../../core/pglite-engine.ts';
import { volunteerContext, VOLUNTEER_DEFAULT_MAX_PAGES } from '../../../core/context/volunteer.ts';
import { DEFAULT_WINDOW_TURNS, renderReflexAddition } from '../../../core/context/reflex.ts';
import type { WindowTurn } from '../../../core/context/entity-salience.ts';
import type {
  AdapterFixtureView,
  HarnessAdapter,
  HarnessTurnResult,
  PublicTurn,
} from '../types.ts';
import { estimateTokens, runReflexPipeline } from './shared.ts';

export const CLAUDE_CODE_MAX_POINTERS = 2;
export const BENCH_USER_PROMPT_DEADLINE_MS = 10_000;

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = 'claude-code' as const;
  readonly seam = 'contract' as const;

  private engine: PGLiteEngine | null = null;
  private sourceId = 'default';
  private window: WindowTurn[] = [];
  private priorInjected = '';

  async beginConversation(engine: PGLiteEngine, fixture: AdapterFixtureView): Promise<void> {
    this.engine = engine;
    this.sourceId = fixture.active_source;
    this.window = [];
    this.priorInjected = '';
  }

  async replayTurn(turn: PublicTurn, _priorContextText: string): Promise<HarnessTurnResult> {
    if (!this.engine) throw new Error('claude-code adapter: beginConversation not called');
    const started = performance.now();
    this.window.push({ role: turn.role, text: turn.text });
    if (this.window.length > DEFAULT_WINDOW_TURNS) {
      this.window = this.window.slice(-DEFAULT_WINDOW_TURNS);
    }

    const block = await runReflexPipeline(this.engine, this.sourceId, turn, this.priorInjected, {
      maxPointers: CLAUDE_CODE_MAX_POINTERS,
      suppression: 'prior-context',
    });
    const pointers = block?.pointers ?? [];
    const volunteered = await volunteerContext(this.engine, this.window, {
      sourceIds: [this.sourceId],
      priorContext: this.priorInjected,
      excludeSlugs: new Set(pointers.map((p) => p.slug)),
      maxPages: VOLUNTEER_DEFAULT_MAX_PAGES,
    });
    const wireText = renderReflexAddition(block?.text ?? null, volunteered);
    if (wireText) this.priorInjected = this.priorInjected ? `${this.priorInjected}\n${wireText}` : wireText;
    const latencyMs = performance.now() - started;
    return {
      injectedText: wireText,
      injectedSlugs: [...pointers.map((p) => p.slug), ...volunteered.map((v) => v.slug)],
      pointers,
      injectedTokens: estimateTokens(wireText),
      latencyMs,
    };
  }

  async endConversation(): Promise<void> {
    this.engine = null;
    this.window = [];
    this.priorInjected = '';
  }
}
