# PMBrain Dream Cycle and Take Review Fix Context

Date: 2026-06-18
Version after fixes: 1.0.12

## Background

The recent PMBrain debugging work focused on the dream cycle and the Admin Console take review flow. The user needed to understand where `propose_takes` pending viewpoints appear, why some viewpoints were in English, how to inspect the source page before accepting or rejecting a viewpoint, and whether the full dream flow could run reliably.

## Problems Found

1. Admin `/admin` was not served correctly from the global `pmbrain serve --http` path in earlier checks.
2. The global `pmbrain` command could drift from the local source tree.
3. `propose_takes` had produced pending `take_proposals`, but the Admin UI did not make the review path obvious enough.
4. Some generated `claim_text` values were English; viewpoint output should be Chinese.
5. The take proposal card showed a page slug, but the reviewer could not click through to inspect original page evidence.
6. `dream --source <id>` passed the source into `runCycle`, but the calibration trio (`propose_takes`, `grade_takes`, `calibration_profile`) inferred source again from `brainDir`, which could scan the wrong source.
7. `propose_takes --dry-run` still called the LLM, so a dry run could block for minutes.
8. `models doctor` used the wrong argv index and displayed the routing table instead of running provider probes.
9. `project_health` and `risk_detect` were not receiving the dream dry-run flag.
10. `dream --help` still described an old eight-phase flow instead of the current full phase list and approval workflow.

## Fixes Implemented

1. Admin take review page
   - Added the Admin Console "观点审批" page.
   - Added pending/accepted/rejected/all filters.
   - Added accept/reject operations that promote accepted proposals into `takes`.
   - Made the "页面" field clickable.
   - Added a source drawer showing page chunks as original evidence.

2. Chinese viewpoint output
   - Updated the `propose_takes` prompt so `claim_text` must be Chinese.
   - Added Chinese domain guidance.
   - Bumped prompt version to `v0.36.1.1-tuned-cat15-cn`.
   - Translated existing English pending rows that were already in the database.

3. Source scoping for calibration phases
   - `propose_takes`, `grade_takes`, and `calibration_profile` now prefer `opts.sourceId`.
   - They only fall back to `resolveSourceForDir(engine, opts.brainDir)` when no explicit source was passed.
   - This fixes `dream --source pmgbrain` scanning the wrong source.

4. Dry-run no-LLM behavior for `propose_takes`
   - `propose_takes --dry-run` now scans pages and checks idempotency cache.
   - It counts cache misses as pages that would need LLM.
   - It does not call the extractor/LLM.
   - It does not write proposals.

5. `models doctor`
   - Fixed subcommand detection so `pmbrain models doctor --json` enters doctor mode.
   - Verified it now probes configured chat, expansion, and embedding surfaces.

6. PM dry-run propagation
   - `project_health`, `risk_detect`, and `report_gen` now receive `dryRun`.
   - `CyclePhase` now includes `project_health`, `risk_detect`, and `report_gen`.
   - Related PM phase typing was tightened enough for the touched paths.

7. Help text
   - `dream --help` now prints the real phase list.
   - It explains the approval workflow:
     `propose_takes -> take_proposals pending -> Admin 观点审批 -> accepted takes -> grade_takes/calibration_profile`.
   - It documents that `propose_takes` dry-run is no-LLM.

## Verification

Passed:

```powershell
bun test test/propose-takes.test.ts test/models-doctor-embed.test.ts test/dream-cli-flags.test.ts
bun run src/cli.ts models doctor --json
bun run src/cli.ts dream --phase propose_takes --dry-run --json --source pmgbrain
bun run src/cli.ts dream --phase project_health --dry-run --json --source pmgbrain
bun run src/cli.ts dream --phase risk_detect --dry-run --json --source pmgbrain
bun run src/cli.ts dream --phase report_gen --dry-run --json --source pmgbrain
bun run src/cli.ts dream --help
```

Observed `propose_takes --dry-run --source pmgbrain` result:

- scanned 3 pages
- 0 cached
- 3 would need LLM
- 0 proposals written
- `dry_run_no_llm: true`
- returned quickly instead of blocking

Service check after restart:

```json
{"status":"ok","version":"1.0.12","engine":"postgres"}
```

## Known Remaining Issues

`bun run typecheck` still has unrelated existing failures:

1. `test/admin-console-intent.test.ts` fetch mock type mismatch.
2. `test/gongwengeshi.test.ts` imports a `.mjs` skill script without a declaration file.
3. `test/training-meeting-notice.test.ts` imports a `.mjs` skill script without a declaration file.

These were not part of the dream-cycle fix and were left untouched.

## Operational Notes

Use this safe diagnostic command before running real proposal extraction:

```powershell
pmbrain dream --phase propose_takes --dry-run --json --source pmgbrain
```

Run real extraction only after confirming the source and page count are expected:

```powershell
pmbrain dream --phase propose_takes --source pmgbrain
```

Review pending proposals in Admin Console:

```text
http://localhost:3131/admin
```

Open "观点审批", click the page card for source evidence, then accept or reject.
