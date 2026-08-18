import { describe, expect, test } from 'bun:test';
import { formatDate } from '../admin/src/lib/shared.tsx';

describe('Admin date display', () => {
  test('formats timestamps in zh-CN 24-hour local time and rejects invalid values', () => {
    expect(formatDate(null)).toBe('无记录');
    expect(formatDate('not-a-date')).toBe('无记录');
    expect(formatDate('2026-08-18T01:30:18.000Z')).toBe(
      new Date('2026-08-18T01:30:18.000Z').toLocaleString('zh-CN', { hour12: false }),
    );
  });
});
