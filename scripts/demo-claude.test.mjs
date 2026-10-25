import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { knownTokens, launchEnv, parseArgs, whoIs } from "./demo-claude.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "demo-claude.mjs");

/** A stand-in for GET /api/me: dev-bill is Dollar Bill, dev-distiller a worker with no principal. */
async function fakeCanon() {
  const server = createServer((req, res) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url !== "/api/me") return send(404, { error: "not found" });
    if (token === "dev-bill") return send(200, { id: "dollar-bill", kind: "person", name: "Dollar Bill", tier: "member", task: "Answer questions about our positions." });
    if (token === "dev-distiller") return send(403, { error: "this token has no principal" });
    return send(401, { error: "unknown token" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function run(args, env = {}) {
  return new Promise((done) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CANON_")));
    const child = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("parseArgs: one person, --url/--token values, --dry-run, and claude's own args after --", () => {
  assert.deepEqual(parseArgs(["dollar-bill", "--url", "https://x", "--dry-run", "--", "--model", "opus"]), {
    person: "dollar-bill", url: "https://x", token: "", dryRun: true, claudeArgs: ["--model", "opus"],
  });
  assert.match(parseArgs(["axe", "ben"]).error, /one person at a time/);
  assert.match(parseArgs(["axe", "--token"]).error, /--token needs a value/);
  assert.match(parseArgs(["axe", "--url", "--dry-run"]).error, /--url needs a value/);
  assert.match(parseArgs(["--verbose"]).error, /unknown option/);
});

test("knownTokens maps client → token, the process env winning over the .env", () => {
  const dotenv = { CANON_CLIENT_TOKENS: "axe=dev-axe,dollar-bill=dev-dollar-bill" };
  assert.equal(knownTokens({}, dotenv).get("dollar-bill"), "dev-dollar-bill");
  assert.equal(knownTokens({ CANON_CLIENT_TOKENS: "dollar-bill=from-shell" }, dotenv).get("dollar-bill"), "from-shell");
  assert.equal(knownTokens({}, {}).size, 0);
});

test("launchEnv switches the whole loop on for the launched process and keeps everything else", () => {
  const env = launchEnv({ PATH: "/bin", CANON_CAPTURE: "0", CANON_CONTEXT: "0" }, { token: "dev-bill", url: "http://h:1" });
  assert.deepEqual(env, { PATH: "/bin", CANON_PERSON_TOKEN: "dev-bill", CANON_URL: "http://h:1", CANON_CAPTURE: "1", CANON_CONTEXT: "1" });
});

test("whoIs: a person opens a session; a worker token, an unknown token or a closed port does not", async () => {
  const canon = await fakeCanon();
  try {
    assert.equal((await whoIs(canon.url, "dev-bill")).person?.name, "Dollar Bill");
    assert.match((await whoIs(canon.url, "dev-distiller")).error, /not a person's/);
    assert.match((await whoIs(canon.url, "nope")).error, /does not know this token/);
  } finally { await canon.close(); }
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  assert.match((await whoIs(`http://127.0.0.1:${port}`, "dev-bill")).error, /cannot reach .*npm run dev/);
});

test("CLI --dry-run names the person and their task, and never prints the token", async () => {
  const canon = await fakeCanon();
  try {
    const ok = await run(["dollar-bill", "--url", canon.url, "--dry-run"], { CANON_CLIENT_TOKENS: "dollar-bill=dev-bill" });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Claude Code as Dollar Bill \(member\) on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(ok.stdout, /their task: Answer questions about our positions\./);
    assert.doesNotMatch(ok.stdout + ok.stderr, /dev-bill/);

    const worker = await run(["distiller", "--url", canon.url, "--dry-run"], { CANON_CLIENT_TOKENS: "distiller=dev-distiller" });
    assert.equal(worker.code, 1);
    assert.match(worker.stderr, /not a person's/);

    const missing = await run(["ben", "--url", canon.url, "--dry-run"], { CANON_CLIENT_TOKENS: "dollar-bill=dev-bill" });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no token for "ben"/);

    const listed = await run(["--url", canon.url], { CANON_CLIENT_TOKENS: "dollar-bill=dev-bill,distiller=dev-distiller" });
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /dollar-bill\s+Dollar Bill \(member\)/);
    assert.doesNotMatch(listed.stdout, /distiller/, "workers are not listed as people");
  } finally { await canon.close(); }
});
