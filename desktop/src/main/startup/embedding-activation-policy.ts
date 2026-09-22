export function requiresFirstActivationAlignment(input: {
  engine: 'pglite' | 'postgres';
  databaseExistedBeforeSave: boolean;
}): boolean {
  return input.engine !== 'pglite' || input.databaseExistedBeforeSave;
}
