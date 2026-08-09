/** PMBrain names are canonical; GBrain names remain read-only fallbacks. */
export function readCompatEnv(
  primary: `PMBRAIN_${string}`,
  legacy: `GBRAIN_${string}`,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env[primary] ?? env[legacy];
}
