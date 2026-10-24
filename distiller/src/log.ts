// One tiny logger so every line from this process is greppable by prefix. Steps log one line
// each with counts and ms (real measurements from timed(), never estimates).

export function log(msg: string): void {
  console.info(`[distiller] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[distiller] ${msg}`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
