import type { BrainEngine } from '../engine.ts';

const FACT_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact', 'idea'] as const;

function constraintText(def: string): string {
  return def.toLowerCase();
}

function isFactKindList(def: string): boolean {
  const text = constraintText(def);
  return text.includes('kind') && text.includes("'event'") && text.includes("'fact'");
}

function allowsIdea(def: string): boolean {
  const text = constraintText(def);
  return isFactKindList(def) && FACT_KINDS.every(kind => text.includes(`'${kind}'`));
}

export async function ensureFactsKindAllowsIdea(engine: BrainEngine): Promise<void> {
  await engine.transaction(async tx => {
    const checks = await tx.executeRaw<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'facts'::regclass AND contype = 'c'`,
    );
    for (const check of checks) {
      if (!isFactKindList(check.def) || allowsIdea(check.def)) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(check.conname)) {
        throw new Error(`无法识别的事实类型约束名：${check.conname}`);
      }
      await tx.executeRaw(`ALTER TABLE facts DROP CONSTRAINT ${check.conname}`);
    }
    const after = await tx.executeRaw<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'facts'::regclass AND contype = 'c'`,
    );
    if (!after.some(row => allowsIdea(row.def))) {
      await tx.executeRaw(
        `ALTER TABLE facts ADD CONSTRAINT facts_kind_check
           CHECK (kind IN ('event','preference','commitment','belief','fact','idea'))`,
      );
    }
  });
}
