// DroidRunner: one step = one headless `droid exec` (Factory Droid CLI) in the run's sandbox
// folder. This is where Droid does the work in Canon (Factory track): on our trigger, in a folder
// holding only its side of the wall, at the lowest autonomy that can write files.
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
//                       the task succeeded, so we check out/ ourselves (exit check, DONE line).
// UNVERIFIED: the docs name the stream-json event types and `toolName` but not the other field
// names. mapDroidEvent() reads them defensively (text / content / message, parameters / input,
// usage.input_tokens / inputTokens). Run one real `droid exec -o stream-json` at the booth and
// fix the field list here if it differs; nothing outside this file depends on it.

import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { env } from "@canon/shared";
import { isRecord } from "../anthropic.ts";
import { CancelledError, addTokens, onPath, saysDone } from "./types.ts";
import type { Runner, StepEvent, StepRequest, StepResult } from "./types.ts";

/** Every droid flag we pass, in one place. */
export const DROID_FLAGS = {
  subcommand: "exec",
  autonomy: ["--auto", "low"],
  output: ["-o", "stream-json"],
  cwd: "--cwd",
  model: "-m",
} as const;

export const DEFAULT_DROID_MODEL = "claude-sonnet-5-5";
const KILL_GRACE_MS = 2000;

/** Canon secrets the agent never needs. Droid gets FACTORY_API_KEY and the plain environment. */
const SCRUBBED_ENV = /^(ANTHROPIC_API_KEY|JEV_API_KEY|CANON_TOKEN_\w+|CANON_CLIENT_TOKENS|MOSS_PROJECT_KEY|MOSS_PROJECT_ID)$/;

export class DroidRunner implements Runner {
  readonly name = "droid" as const;
  readonly simulated = false;
  private readonly model: string;

  constructor(opts: { model?: string } = {}) {
    if (!env("FACTORY_API_KEY")) throw new Error("DroidRunner: FACTORY_API_KEY is not set. Put it in .env, or set DISPATCH_RUNTIME=claude|fake.");
    if (!onPath("droid")) throw new Error("DroidRunner: the droid binary is not on PATH (install: https://app.factory.ai/cli), or set DISPATCH_RUNTIME=claude|fake.");
    this.model = opts.model ?? env("DISPATCH_DROID_MODEL", DEFAULT_DROID_MODEL);
  }

  args(req: StepRequest): string[] {
    return [DROID_FLAGS.subcommand, ...DROID_FLAGS.autonomy, ...DROID_FLAGS.output, DROID_FLAGS.cwd, req.dir, DROID_FLAGS.model, this.model, req.prompt];
  }

  step(req: StepRequest): Promise<StepResult> {
    if (req.signal.aborted) return Promise.reject(new CancelledError());
    const childEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!SCRUBBED_ENV.test(k)) childEnv[k] = v;

    return new Promise<StepResult>((resolvePromise, reject) => {
      // The command is looked up on childEnv.PATH, so a test's fake droid on PATH is what runs.
      const child = spawn("droid", this.args(req), { cwd: req.dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let settled = false;
      let buffer = "";
      let stderr = "";
      let lastMessage = "";
      let completion: { text: string; tokens?: { input: number; output: number } } | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
        fn();
      };
      const kill = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };
      const onAbort = () => {
        kill();
        finish(() => reject(new CancelledError("droid step cancelled; process killed")));
      };
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new Error(`droid step timed out after ${req.timeoutMs} ms; process killed`)));
      }, req.timeoutMs);
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
          if (!settled) req.emit(s);
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
      child.on("error", (err) => finish(() => reject(new Error(`cannot start droid: ${err.message}`))));
      child.on("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        if (buffer) handleLine(buffer);
        finish(() => {
          if (code !== 0) {
            const tail = stderr.trim().split("\n").slice(-3).join(" | ");
            reject(new Error(`droid exec exited ${code ?? signal}${tail ? `: ${tail}` : ""}`));
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
