// DroidRunner: one step = one headless `droid exec` (Factory Droid CLI) in the run's sandbox
// folder. This is where Droid does the work in Bullwark (Factory track): on our trigger, in a
// folder holding only the agent's scope, at the lowest autonomy that can write files.
//
// Flags, from Factory's docs (docs.factory.ai/cli/droid-exec/overview, which redirects to
// docs.factory.com, and the CLI reference; read 2026-10-24):
//   --auto low          "the lowest level that allows creating and editing project files. It
//                       blocks system changes, package installs, remote writes, and production
//                       changes." Without --auto a run is read-only. An action above the level
//                       stops the run with an error on stderr and a non-zero exit.
//   -o stream-json      "one JSON event per line as the run progresses". Event types named in the
//                       docs: system (cwd, model, tools), message, tool_call (with `toolName`),
//                       tool_result, and a final completion (response text + usage). The `json`
//                       result's usage has input_tokens / output_tokens.
//   --cwd <path>        "Execute from a specific working directory (use an absolute path)".
//   -m <id>             model id (the docs' example is claude-opus-5-5).
//   prompt              a positional argument (also -f <file> or stdin).
//   FACTORY_API_KEY     the API key, from the environment.
//   Exit codes          0 when the run completes, non-zero when it stops early. 0 does not mean
//                       the task succeeded, so we check out/ ourselves (the DONE line, files in out/).
// UNVERIFIED: the docs name the stream-json event types and `toolName` but not the other field
// names. mapDroidEvent() reads them defensively (text / content / message, parameters / input,
// usage.input_tokens / inputTokens). Run one real `droid exec -o stream-json` at the booth and
// fix the field list here if it differs; nothing outside this file depends on it.
//
// Confinement. Nothing in Factory's docs says Droid's reads stay inside --cwd (`--auto low` allows
// read-only inspection of files, folders and the environment), so code does what it can:
//   - the sandbox lives outside the repo and the data dir (sandbox.ts agentsRoot());
//   - agentEnv() drops Bullwark's secrets and every env value that points into the repo or the data
//     dir (npm_*, INIT_CWD, PWD, NODE_OPTIONS, ...), and PATH entries inside them;
//   - on macOS, droid runs under sandbox-exec with a profile that denies reads and writes of the
//     repo, the data dir and every other run's folder (DISPATCH_OS_SANDBOX=auto|on|off, default auto);
//   - droid leads its own process group: a cancel or a timeout kills the whole tree (the shells and
//     scripts its tools started), and the step settles only after droid has exited, so the
//     dispatcher never locks a folder under a live process. Leftovers are killed after every step.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { env } from "@canon/shared";
import { isRecord } from "../anthropic.ts";
import { log } from "../log.ts";
import { realPath, storeRoots } from "../sandbox.ts";
import { CancelledError, StepError, addTokens, onPath, saysDone } from "./types.ts";
import type { Runner, StepEvent, StepRequest, StepResult } from "./types.ts";

/** Every droid flag we pass, in one place. */
export const DROID_FLAGS = {
  subcommand: "exec",
  autonomy: ["--auto", "low"],
  output: ["-o", "stream-json"],
  cwd: "--cwd",
  model: "-m",
} as const;

const KILL_GRACE_MS = 2000;
/** After SIGKILL, how long to wait for droid to be gone before settling anyway. */
const CLOSE_WAIT_MS = 3000;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Bullwark's secrets and settings (CANON_*) the agent never needs. Droid gets FACTORY_API_KEY and the plain environment. */
const SCRUBBED_ENV = /^(ANTHROPIC_API_KEY|JEV_API_KEY|CANON_\w+|MOSS_PROJECT_KEY|MOSS_PROJECT_ID)$|(?:TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|API_KEY)/i;

/** Process groups of droid steps still running, killed if the worker exits underneath them. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // the group is gone
  }
}

/**
 * The environment droid runs with: no Bullwark secrets, no value that points into the repo or the
 * data dir (the sandbox is outside both, and an env var must not hand the way back), PATH without
 * entries inside them, and PWD set to the sandbox.
 */
export function agentEnv(dir: string, base: NodeJS.ProcessEnv = process.env, hidden: readonly string[] = storeRoots()): NodeJS.ProcessEnv {
  const inside = (p: string) => hidden.some((h) => p === h || p.startsWith(h + sep));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || (k !== "FACTORY_API_KEY" && SCRUBBED_ENV.test(k))) continue;
    if (k === "PATH") {
      out.PATH = v
        .split(delimiter)
        .filter((p) => p !== "" && !inside(resolve(p)))
        .join(delimiter);
      continue;
    }
    if (hidden.some((h) => v.includes(h))) continue;
    out[k] = v;
  }
  out.PWD = dir;
  // Prevent automatic discovery of the operator's Factory config, MCP servers and cached
  // credentials. The only provider credential in this child is its explicit Factory API key.
  out.HOME = dir;
  out.USERPROFILE = dir;
  return out;
}

/**
 * A Seatbelt profile that allows everything except reading or writing under `denied`, with
 * `allowed` carved back out (the last matching rule wins). Paths must be real paths.
 */
export function seatbeltProfile(denied: readonly string[], allowed: readonly string[] = []): string {
  const rule = (verb: "allow" | "deny", p: string) => `(${verb} file-read* file-write* (subpath ${JSON.stringify(p)}))`;
  return ["(version 1)", "(allow default)", ...denied.map((d) => rule("deny", d)), ...allowed.map((a) => rule("allow", a))].join("\n");
}

/** For one step: the repo, the data dir and every other run's folder are denied; this run's folder is not. */
export function stepProfile(dir: string, executable?: string): string {
  const own = realPath(dir);
  return seatbeltProfile([...storeRoots(), realPath(homedir()), dirname(own)], [own, ...(executable ? [realPath(executable)] : [])]);
}

export type OsSandbox = "seatbelt" | "none";

/**
 * DISPATCH_OS_SANDBOX: auto (default) uses sandbox-exec on macOS when it works here (it does not
 * nest inside another sandbox), on requires it, off skips it.
 */
export function resolveOsSandbox(mode = env("DISPATCH_OS_SANDBOX", "auto")): OsSandbox {
  if (mode === "off") return "none";
  if (mode !== "auto" && mode !== "on") throw new Error(`DISPATCH_OS_SANDBOX must be auto, on or off (got "${mode}")`);
  const usable =
    process.platform === "darwin" && existsSync(SANDBOX_EXEC) && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
  if (usable) return "seatbelt";
  if (mode === "on") throw new Error("DISPATCH_OS_SANDBOX=on, but sandbox-exec is not usable here (macOS only, and it does not nest)");
  return "none";
}

export class DroidRunner implements Runner {
  readonly name = "droid" as const;
  readonly simulated = false;
  readonly osSandbox: OsSandbox;
  private readonly model: string | undefined;
  private readonly bin: string;

  constructor(opts: { model?: string; osSandbox?: OsSandbox } = {}) {
    if (!env("FACTORY_API_KEY")) throw new Error("DroidRunner: FACTORY_API_KEY is not set. Put it in .env, or set DISPATCH_RUNTIME=claude|fake.");
    const bin = onPath("droid");
    if (!bin) throw new Error("DroidRunner: the droid binary is not on PATH (install: https://app.factory.ai/cli), or set DISPATCH_RUNTIME=claude|fake.");
    this.bin = bin;
    // The pinned 0.249.0 CLI does not list claude-sonnet-5-5. Let Factory select the account's
    // supported default unless the operator explicitly supplies a catalog id.
    this.model = opts.model ?? env("DISPATCH_DROID_MODEL");
    this.osSandbox = opts.osSandbox ?? resolveOsSandbox();
    log(
      this.osSandbox === "seatbelt"
        ? "droid runs under sandbox-exec: the repo and the data dir are denied to it"
        : "droid runs WITHOUT an OS sandbox: only the folder's location and the env scrub keep it away from the repo (README, Limits)",
    );
  }

  args(req: StepRequest): string[] {
    return [DROID_FLAGS.subcommand, ...DROID_FLAGS.autonomy, ...DROID_FLAGS.output, "--disable-builtin-skills", "--only-tools", "Read,LS,Grep,Glob,Create,Edit", DROID_FLAGS.cwd, req.dir, ...(this.model ? [DROID_FLAGS.model, this.model] : []), req.prompt];
  }

  /** What is actually spawned: droid itself, or droid under sandbox-exec. */
  command(req: StepRequest): { file: string; args: string[] } {
    if (this.osSandbox === "seatbelt") return { file: SANDBOX_EXEC, args: ["-p", stepProfile(req.dir, this.bin), this.bin, ...this.args(req)] };
    return { file: this.bin, args: this.args(req) };
  }

  step(req: StepRequest): Promise<StepResult> {
    if (req.signal.aborted) return Promise.reject(new CancelledError());
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => {
        for (const pid of liveGroups) killGroup(pid, "SIGKILL");
      });
    }

    return new Promise<StepResult>((resolvePromise, reject) => {
      const { file, args } = this.command(req);
      // detached: droid leads its own process group, so a kill reaches everything its tools started.
      const child = spawn(file, args, { cwd: req.dir, env: agentEnv(req.dir), stdio: ["ignore", "pipe", "pipe"], detached: true });
      const pid = child.pid;
      if (pid !== undefined) liveGroups.add(pid);
      let settled = false;
      /** Set by a cancel or a timeout: the step fails with this once droid is gone. */
      let stopping: Error | undefined;
      let buffer = "";
      let stderr = "";
      let lastMessage = "";
      let completion: { text: string; tokens?: { input: number; output: number } } | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let giveUpTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        req.signal.removeEventListener("abort", onAbort);
        if (pid !== undefined) liveGroups.delete(pid);
        fn();
      };
      /** SIGTERM the whole group, SIGKILL after the grace period; settle once droid has exited. */
      const stop = (err: Error) => {
        if (stopping || settled) return;
        stopping = err;
        clearTimeout(timer);
        killGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => {
          killGroup(pid, "SIGKILL");
          giveUpTimer = setTimeout(() => finish(() => reject(err)), CLOSE_WAIT_MS);
        }, KILL_GRACE_MS);
      };
      const onAbort = () => stop(new CancelledError("droid step cancelled; process group killed"));
      const timer = setTimeout(
        () => stop(new StepError(`timed out after ${req.timeoutMs} ms`, `droid step timed out after ${req.timeoutMs} ms; process group killed`)),
        req.timeoutMs,
      );
      req.signal.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return; // banners and progress text are not events
        let ev: unknown;
        try {
          ev = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (!isRecord(ev)) return;
        const mapped = mapDroidEvent(ev, req.dir);
        for (const s of mapped.steps) {
          if (s.kind === "message") lastMessage = s.text;
          if (!settled && !stopping) req.emit(s); // a stopped agent's last words do not stream
        }
        if (mapped.completion) completion = { text: mapped.completion.text, tokens: addTokens(completion?.tokens, mapped.completion.tokens) };
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      child.on("error", (err) => {
        // Only a failed spawn has no process to wait for; any other error (a failed kill) is not fatal.
        if (pid === undefined) finish(() => reject(new StepError("could not start droid", err.message)));
      });
      // Droid itself is gone: nothing it started outlives the step.
      child.on("exit", () => killGroup(pid, "SIGKILL"));
      child.on("close", (code, signal) => {
        killGroup(pid, "SIGKILL");
        if (buffer && !stopping) handleLine(buffer);
        finish(() => {
          if (stopping) {
            reject(stopping);
            return;
          }
          if (code !== 0) {
            const tail = stderr.trim().split("\n").slice(-3).join(" | ");
            reject(new StepError(`droid exec exited ${code ?? signal}`, tail || undefined));
            return;
          }
          const text = completion?.text || lastMessage;
          const result: StepResult = { done: saysDone(text), summary: text.slice(0, 2000) || "(droid reported no text)" };
          if (completion?.tokens) result.tokens = completion.tokens;
          resolvePromise(result);
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// stream-json -> AgentStep kinds. Field names beyond `type` and `toolName` are UNVERIFIED (above).

function str(...xs: unknown[]): string | undefined {
  for (const x of xs) {
    if (typeof x === "string" && x.trim() !== "") return x;
    // content as a list of blocks: [{ type: "text", text }]
    if (Array.isArray(x)) {
      const t = x
        .map((b) => (isRecord(b) && typeof b.text === "string" ? b.text : typeof b === "string" ? b : ""))
        .join("")
        .trim();
      if (t) return t;
    }
  }
  return undefined;
}

function num(...xs: unknown[]): number | undefined {
  for (const x of xs) if (typeof x === "number" && Number.isFinite(x)) return x;
  return undefined;
}

export function droidTokens(usage: unknown): { input: number; output: number } | undefined {
  if (!isRecord(usage)) return undefined;
  const input = num(usage.input_tokens, usage.inputTokens);
  const output = num(usage.output_tokens, usage.outputTokens);
  return input !== undefined && output !== undefined ? { input, output } : undefined;
}

const FILE_TOOLS = /^(create|edit|multi_?edit|write|apply_?patch|str_replace\w*)$/i;

/** One stream-json event as the steps it shows on the lane, plus the completion when it is one. */
export function mapDroidEvent(ev: Record<string, unknown>, dir: string): { steps: StepEvent[]; completion?: { text: string; tokens?: { input: number; output: number } } } {
  const type = String(ev.type ?? "");
  const nested = isRecord(ev.message) ? ev.message : {};
  switch (type) {
    case "system":
      return { steps: [] };
    case "message": {
      const role = String(ev.role ?? nested.role ?? "assistant");
      if (role !== "assistant") return { steps: [] };
      const text = str(ev.text, ev.content, nested.content, nested.text, typeof ev.message === "string" ? ev.message : undefined);
      return text ? { steps: [{ kind: "message", text: clip(text) }] } : { steps: [] };
    }
    case "tool_call": {
      const name = String(ev.toolName ?? ev.tool_name ?? ev.name ?? ev.tool ?? "tool");
      const params = [ev.parameters, ev.params, ev.input, ev.arguments, ev.args].find(isRecord) ?? {};
      const steps: StepEvent[] = [{ kind: "tool", text: clip(`${name} ${summarizeParams(params)}`.trim()) }];
      const path = str(params.file_path, params.filePath, params.path);
      if (path && FILE_TOOLS.test(name)) steps.push({ kind: "file", text: `${name} ${relPath(dir, path)}`, file: relPath(dir, path) });
      return { steps };
    }
    case "tool_result": {
      const isError = ev.isError === true || ev.is_error === true || (ev.error !== undefined && ev.error !== null && ev.error !== false);
      if (!isError) return { steps: [] };
      return { steps: [{ kind: "error", text: clip(`tool error: ${str(ev.error, ev.value, ev.content, ev.result) ?? "(no detail)"}`) }] };
    }
    case "completion":
    case "result": {
      const text = str(ev.finalText, ev.final_text, ev.text, ev.result, ev.content, nested.content) ?? "";
      const tokens = droidTokens(ev.usage ?? nested.usage);
      const step: StepEvent = { kind: "result", text: clip(text || "(no final text)") };
      if (tokens) step.tokens = tokens;
      return { steps: [step], completion: tokens ? { text, tokens } : { text } };
    }
    case "error":
      return { steps: [{ kind: "error", text: clip(str(ev.message, ev.error, ev.text) ?? "droid reported an error") }] };
    default:
      return { steps: [] };
  }
}

function summarizeParams(params: Record<string, unknown>): string {
  const path = str(params.file_path, params.filePath, params.path);
  if (path) return path;
  const cmd = str(params.command, params.cmd, params.pattern, params.query);
  if (cmd) return cmd;
  const keys = Object.keys(params);
  return keys.length ? `(${keys.slice(0, 4).join(", ")})` : "";
}

/** A path droid reported, relative to the sandbox when it is inside it. */
function relPath(dir: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(dir, p);
  const rel = relative(dir, abs);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split(sep).join("/") : p;
}

function clip(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
