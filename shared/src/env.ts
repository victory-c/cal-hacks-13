// .env loading without a dependency. Every entrypoint calls loadEnv() first.
// Keys come from .env only (see .env.example). Existing process env wins over the file.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repo root (this file lives at shared/src/env.ts). */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function loadEnv(): boolean {
  const file = join(REPO_ROOT, ".env");
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

export function env(name: string): string | undefined;
export function env(name: string, fallback: string): string;
export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return v;
}

/** CANON_DATA_DIR resolved against the repo root; defaults to <repo>/data (gitignored). */
export function dataDir(): string {
  const raw = env("CANON_DATA_DIR", "data");
  return isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
}
