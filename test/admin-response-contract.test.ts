import { describe, expect, spyOn, test } from 'bun:test';
import type { Response } from 'express';
import { sendAdminContract } from '../src/commands/admin-response-contract.ts';
import { BrainPagesResponseSchema } from '../shared/contracts/brain.ts';

function fakeResponse() {
  const calls: Array<{ status: number; payload: unknown }> = [];
  let status = 200;
  const response = {
    status(value: number) {
      status = value;
      return response;
    },
    json(payload: unknown) {
      calls.push({ status, payload });
      return response;
    },
  };
  return { response: response as unknown as Response, calls };
}

describe('Admin response contracts', () => {
  test('accepts the documented brain page response', () => {
    const { response, calls } = fakeResponse();
    sendAdminContract(response, BrainPagesResponseSchema, {
      rows: [], total: 0, page: 1, limit: 10, pages: 1,
    });
    expect(calls).toEqual([{ status: 200, payload: { rows: [], total: 0, page: 1, limit: 10, pages: 1 } }]);
  });

  test('turns a backend field rename into a stable contract failure', () => {
    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { response, calls } = fakeResponse();
      sendAdminContract(response, BrainPagesResponseSchema, {
        rows: [], total: 0, page: 1, limit: 10, pageCount: 1,
      });
      expect(calls).toEqual([{ status: 500, payload: { error: 'admin_response_contract_violation' } }]);
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
