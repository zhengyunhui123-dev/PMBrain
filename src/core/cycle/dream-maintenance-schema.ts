export const DREAM_MAINTENANCE_SCHEMA_SQL = `
ALTER TABLE extract_atoms_transcript_state ADD COLUMN IF NOT EXISTS partial_input_chars INTEGER;

CREATE TABLE IF NOT EXISTS link_edge_proposals (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT NOT NULL,
  from_page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  a_to_page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  b_to_page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type     TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'dismissed')),
  rationale     TEXT NOT NULL DEFAULT '',
  model         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT link_edge_proposals_uniq UNIQUE (from_page_id, a_to_page_id, b_to_page_id, link_type, evidence_hash)
);
CREATE INDEX IF NOT EXISTS link_edge_proposals_source_idx
  ON link_edge_proposals (source_id, status);

CREATE TABLE IF NOT EXISTS pinned_questions (
  id              BIGSERIAL PRIMARY KEY,
  source_id       TEXT NOT NULL,
  slug            TEXT NOT NULL DEFAULT '',
  question        TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'inactive')),
  cooldown_days   INTEGER NOT NULL DEFAULT 1,
  origin          TEXT NOT NULL DEFAULT 'pin' CHECK (origin IN ('config', 'pin')),
  answer          TEXT,
  answer_model    TEXT,
  last_refresh_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS pinned_questions_origin_question_uniq
  ON pinned_questions (source_id, origin, question);
CREATE INDEX IF NOT EXISTS pinned_questions_due_idx
  ON pinned_questions (source_id, state, last_refresh_at);

CREATE TABLE IF NOT EXISTS question_evidence (
  id          BIGSERIAL PRIMARY KEY,
  question_id BIGINT NOT NULL REFERENCES pinned_questions(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  excerpt     TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS question_evidence_question_idx ON question_evidence (question_id);
`;
