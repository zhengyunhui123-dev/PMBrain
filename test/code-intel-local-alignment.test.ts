import { expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

test('unscoped code readers refuse remote or unspecified trust before reading', async () => {
  for (const name of ['code_callers', 'code_callees', 'code_def', 'code_refs', 'code_blast', 'code_flow']) {
    for (const remote of [true, undefined]) {
      await expect(operationsByName[name].handler({ remote } as OperationContext, { symbol: 'test' })).rejects.toMatchObject({ code: 'permission_denied' });
    }
  }
});
