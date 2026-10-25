// One logger for the dispatcher process, so its lines are greppable apart from the distiller's.
// Counts and ms in log lines are real measurements, never estimates.

export function log(msg: string): void {
  console.info(`[dispatch] ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`[dispatch] ${msg}`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line of an error, trimmed, for one-line run reasons on the dashboard. */
export function shortReason(err: unknown, max = 160): string {
  const first = errorMessage(err).split("\n")[0].trim();
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
