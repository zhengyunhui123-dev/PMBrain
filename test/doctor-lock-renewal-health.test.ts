import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from './helpers/with-env.ts';
import { checkLockRenewalHealth } from '../src/commands/doctor.ts';
import { lockRenewalAudit } from '../src/core/audit/lock-renewal-audit.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-lock-renewal-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('doctor lock_renewal_health', () => {
  test('reports ok when no lock-renewal failures were audited', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      const check = await checkLockRenewalHealth({} as never);
      expect(check.name).toBe('lock_renewal_health');
      expect(check.status).toBe('ok');
      expect(check.message).toContain('No lock-renewal failures');
    });
  });

  test('reports fail when a renewal gave up', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      lockRenewalAudit.logGaveUp(42, 'sync', 5, new Error('renew lock timeout'));
      const check = await checkLockRenewalHealth({} as never);
      expect(check.name).toBe('lock_renewal_health');
      expect(check.status).toBe('fail');
      expect(check.message).toContain('gave up');
      expect(check.message).toContain('sync#42');
    });
  });
});
