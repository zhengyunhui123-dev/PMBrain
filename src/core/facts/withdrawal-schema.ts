export const FINGERPRINT_PUNCTUATION = '!"$%&\'()*,-/:;<=>?@[\\]^_`{|}~\u2018\u2019\u201a\u201c\u201d\u201e\u00ab\u00bb\u2039\u203a\u2013\u2014\u2015\u2026\u00b7\u2022\u00a1\u00bf';

export function normalizeLoweredClaim(claim: string): string {
  let out = '';
  for (const char of claim) out += FINGERPRINT_PUNCTUATION.includes(char) ? ' ' : char;
  return out.replace(/ +/g, ' ').replace(/\.(?=[. ]|$)/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
}

const NORMALIZE_CLAIM_SQL = `pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.translate(pg_catalog.lower(claim), '${FINGERPRINT_PUNCTUATION.replace(/'/g, "''")}', '${' '.repeat([...FINGERPRINT_PUNCTUATION].length)}'), '[[:space:]]+', ' ', 'g'), '\\.(?=[. ]|$)', ' ', 'g'), ' +', ' ', 'g'), ' ')`;

export const FACT_FINGERPRINT_FUNCTION_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint_v1(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$
      SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(claim)), '[[:space:]]+', ' ', 'g'), 'UTF8')), 'hex')
    $fn$`,
  `CREATE OR REPLACE FUNCTION gbrain_fact_normalize(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT ${NORMALIZE_CLAIM_SQL} $fn$`,
  `CREATE OR REPLACE FUNCTION gbrain_fact_fingerprint(claim TEXT) RETURNS TEXT
    LANGUAGE SQL IMMUTABLE STRICT AS $fn$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(${NORMALIZE_CLAIM_SQL}, 'UTF8')), 'hex') $fn$`,
] as const;

export const FACT_WITHDRAWAL_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS fact_withdrawals (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','world')),
    subject TEXT NOT NULL DEFAULT '*',
    fact_hash TEXT NOT NULL,
    withdrawn_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (source_id, visibility, subject, fact_hash)
  )`,
  ...FACT_FINGERPRINT_FUNCTION_STATEMENTS,
  `CREATE OR REPLACE FUNCTION gbrain_preserve_fact_withdrawal() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
    DECLARE withdrawn TIMESTAMPTZ;
    BEGIN
      IF NEW.expired_at IS NULL THEN
        PERFORM id FROM sources WHERE id = NEW.source_id FOR SHARE;
        SELECT min(withdrawn_at) INTO withdrawn FROM fact_withdrawals
          WHERE source_id = NEW.source_id AND visibility = NEW.visibility
            AND (subject = '*' OR subject = NEW.entity_slug)
            AND fact_hash IN (gbrain_fact_fingerprint(NEW.fact), gbrain_fact_fingerprint_v1(NEW.fact));
        IF withdrawn IS NOT NULL THEN
          NEW.expired_at := withdrawn;
          NEW.valid_until := LEAST(COALESCE(NEW.valid_until, withdrawn), withdrawn);
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$`,
  `DROP TRIGGER IF EXISTS facts_preserve_withdrawal ON facts`,
  `CREATE TRIGGER facts_preserve_withdrawal BEFORE INSERT OR UPDATE OF fact, source_id, visibility, entity_slug, expired_at ON facts
    FOR EACH ROW EXECUTE FUNCTION gbrain_preserve_fact_withdrawal()`,
] as const;

export const FACT_WITHDRAWAL_SCHEMA_SQL = FACT_WITHDRAWAL_SCHEMA_STATEMENTS.join(';\n') + ';\n';

export const FACT_WITHDRAWAL_BACKFILL_SQL = `INSERT INTO fact_withdrawals(source_id, visibility, fact_hash, withdrawn_at)
  SELECT source_id, visibility, gbrain_fact_fingerprint(fact), min(expired_at)
  FROM facts
  WHERE expired_at IS NOT NULL AND context LIKE '%forgotten:%' AND context NOT LIKE '%superseded by fact #%'
  GROUP BY source_id, visibility, gbrain_fact_fingerprint(fact)
  ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS idx_facts_withdrawal_fingerprint ON facts (source_id, visibility, gbrain_fact_fingerprint(fact));
UPDATE facts f SET expired_at = w.withdrawn_at, valid_until = LEAST(COALESCE(f.valid_until, w.withdrawn_at), w.withdrawn_at)
  FROM (SELECT source_id, visibility, subject, fact_hash, min(withdrawn_at) AS withdrawn_at FROM fact_withdrawals
    GROUP BY source_id, visibility, subject, fact_hash) w
  WHERE f.expired_at IS NULL AND f.source_id = w.source_id AND f.visibility = w.visibility
    AND (w.subject = '*' OR w.subject = f.entity_slug) AND gbrain_fact_fingerprint(f.fact) = w.fact_hash;
`;
