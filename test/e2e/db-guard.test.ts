/**
 * Unit tests for the setupDB/direct-Postgres database name floor.
 * Pure: no database connection is made.
 */

import { describe, expect, test } from 'bun:test';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const NO_ENV = {} as Record<string, string | undefined>;

describe('assertSafeE2eDatabaseUrl', () => {
  test('allows the canonical isolated test database', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl(
        'postgresql://postgres:postgres@localhost:5434/gbrain_test',
        NO_ENV,
      ),
    ).not.toThrow();
  });

  test('allows test as a database-name segment', () => {
    for (const name of ['test', 'test_gbrain', 'e2e-test', 'gbrain_test_2', 'TEST_DB']) {
      expect(() =>
        assertSafeE2eDatabaseUrl(`postgresql://u:p@localhost:5432/${name}`, NO_ENV),
      ).not.toThrow();
    }
  });

  test('refuses the formal and ambiguous database names from the incident', () => {
    for (const name of [
      'gbrain',
      'gbrain_restored_20260813',
      'gbrain_relold',
      'pmbrain',
      'postgres',
      'prod',
      'contest',
      'latest',
    ]) {
      expect(() =>
        assertSafeE2eDatabaseUrl(`postgresql://u:p@localhost:5432/${name}`, NO_ENV),
      ).toThrow(/does not look like a test database/);
    }
  });

  test('refuses a Supabase-style pooler URL with a bare postgres database', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl(
        'postgresql://postgres.ref:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
        NO_ENV,
      ),
    ).toThrow(/does not look like a test database/);
  });

  test('supports an explicit exact-name override only when it matches', () => {
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://u:p@localhost:5432/gbrain', {
        GBRAIN_E2E_ALLOW_DB: 'gbrain',
      }),
    ).not.toThrow();
    expect(() =>
      assertSafeE2eDatabaseUrl('postgresql://u:p@localhost:5432/gbrain', {
        GBRAIN_E2E_ALLOW_DB: 'other_db',
      }),
    ).toThrow(/does not look like a test database/);
  });

  test('refuses malformed URLs and URLs without a database name', () => {
    expect(() => assertSafeE2eDatabaseUrl('not a url', NO_ENV)).toThrow(/not a parseable URL/);
    expect(() => assertSafeE2eDatabaseUrl('postgresql://u:p@localhost:5432/', NO_ENV)).toThrow(
      /no database name/,
    );
  });
});
