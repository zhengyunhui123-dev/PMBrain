declare const value: unknown;
declare const sql: { json(value: unknown): unknown };
const payload = sql.json(value);
void payload;
export {};
