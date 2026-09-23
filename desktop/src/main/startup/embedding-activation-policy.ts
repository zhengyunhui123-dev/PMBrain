export function requiresFirstActivationAlignment(input: {
  engine: 'pglite' | 'postgres';
  databaseExistedBeforeSave: boolean;
}): boolean {
  return true;
}
