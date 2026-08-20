/**
 * Production guard for tests that run destructive SQL against DATABASE_URL.
 *
 * PMBrain's E2E setup truncates data tables on whatever DATABASE_URL points
 * at. Direct Postgres tests can carry the same risk, so they must call this
 * guard before connecting when they mutate schema or data.
 *
 * Refuse unless the database name identifies itself as a test database
 * ("test" as a word segment, for example gbrain_test), or the operator
 * explicitly opts the exact name in via GBRAIN_E2E_ALLOW_DB.
 *
 * Pure: no connection is made.
 */
export function assertSafeE2eDatabaseUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
): void {
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('E2E guard: DATABASE_URL is not a parseable URL; refusing to run destructive setup.');
  }
  if (!dbName) {
    throw new Error('E2E guard: DATABASE_URL has no database name; refusing to run destructive setup.');
  }
  if (/(^|[_-])test([_-]|$)/i.test(dbName)) return;
  if (env.GBRAIN_E2E_ALLOW_DB && env.GBRAIN_E2E_ALLOW_DB === dbName) return;
  throw new Error(
    `E2E guard: database "${dbName}" does not look like a test database `
    + '(expected "test" as a name segment, e.g. gbrain_test). This test runs '
    + 'destructive SQL against it. If this is intentional, set '
    + `GBRAIN_E2E_ALLOW_DB=${dbName} to opt in explicitly.`,
  );
}
