/**
 * Invocation-level guard: refuse to start a test run while a database URL is
 * ambient in the environment, unless the invoker explicitly opted in.
 *
 * The per-file name floor in db-guard.ts is the second layer. This preload is
 * the first: no test file loads while an unexpected database URL is present.
 * E2E wrappers opt in only at their subprocess boundary; unit wrappers remove
 * both variables before invoking Bun.
 *
 * HARD-FAIL, never silently unset: silently clearing the variable would turn
 * DATABASE_URL-gated E2E tests into green skips and hide the dangerous path.
 * Both names are checked because PMBrain's runtime accepts both spellings.
 */

const ALLOW = process.env.GBRAIN_TEST_ALLOW_DATABASE_URL === '1';

if (!ALLOW) {
  const offending = (['DATABASE_URL', 'GBRAIN_DATABASE_URL'] as const).filter(
    (name) => {
      const value = process.env[name];
      return value !== undefined && value !== '';
    },
  );

  if (offending.length > 0) {
    console.error(
      [
        `TEST-RUN GUARD: refusing to start — ${offending.join(' and ')} ${offending.length === 1 ? 'is' : 'are'} set.`,
        '',
        'Some tests run destructive SQL (TRUNCATE/DELETE/DROP) against whatever',
        'these URLs point at. A bare `bun test` with a real brain URL in the',
        'environment can wipe that brain.',
        '',
        'Pick one:',
        `  - unset the variable${offending.length > 1 ? 's' : ''} and re-run (unit tests need no database).`,
        '  - run the E2E suite through its wrapper: `bun run test:e2e`,',
        '    which validates the database name before any psql cleanup; or',
        '  - one-shot opt in only when you intentionally supplied a test URL:',
        '    `GBRAIN_TEST_ALLOW_DATABASE_URL=1 bun test ...`.',
        '    The per-file guard still requires a test-shaped database name.',
      ].join('\n'),
    );
    process.exit(1);
  }
}
