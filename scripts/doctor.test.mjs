import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the real scripts/doctor.mjs from an isolated copy of the repo root, so the working
// checkout's .env is never read or touched.
const doctor = join(dirname(fileURLToPath(import.meta.url)), "doctor.mjs");

function isolatedRoot(dotenv) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "status"));
  mkdirSync(join(root, "node_modules", "@canon", "shared"), { recursive: true });
  copyFileSync(doctor, join(root, "scripts", "doctor.mjs"));
  writeFileSync(join(root, "status", "status.json"), JSON.stringify({ updated: "test" }));
  if (dotenv !== undefined) writeFileSync(join(root, ".env"), dotenv);
  return root;
}

/** Ports the doctor probed, as reported in its output. */
function probed(dotenv, shellEnv = {}) {
  const root = isolatedRoot(dotenv);
  try {
    const env = { ...process.env, ...shellEnv };
    for (const k of ["CANON_PORT", "WEB_PORT"]) if (!(k in shellEnv)) delete env[k];
    const r = spawnSync(process.execPath, [join(root, "scripts", "doctor.mjs")], { env, encoding: "utf8" });
    const find = (name) => Number(new RegExp(`port (\\d+) (?:free|busy) \\(${name}\\)`).exec(r.stdout)?.[1]);
    return { server: find("server"), web: find("web"), out: r.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const dotenv = "CANON_PORT=4111\nWEB_PORT=4222\n";

test("defaults when neither the shell nor .env sets a port", () => {
  assert.deepEqual(pick(probed(undefined)), { server: 4100, web: 4200 });
  assert.deepEqual(pick(probed("# nothing here\n")), { server: 4100, web: 4200 });
});

test(".env ports are used when the shell sets none", () => {
  assert.deepEqual(pick(probed(dotenv)), { server: 4111, web: 4222 });
});

test("shell-only ports are used without a .env", () => {
  assert.deepEqual(pick(probed(undefined, { CANON_PORT: "49999", WEB_PORT: "49998" })), { server: 49999, web: 49998 });
});

test("shell overrides win over conflicting .env ports, like the runtime", () => {
  assert.deepEqual(pick(probed(dotenv, { CANON_PORT: "49999", WEB_PORT: "49998" })), { server: 49999, web: 49998 });
  // Overriding one variable leaves the other on its .env value.
  assert.deepEqual(pick(probed(dotenv, { WEB_PORT: "49998" })), { server: 4111, web: 49998 });
});

test("an empty shell value counts as unset and falls to the default, like env()", () => {
  assert.deepEqual(pick(probed(dotenv, { CANON_PORT: "", WEB_PORT: "" })), { server: 4100, web: 4200 });
});

test("busy-port warning follows the shell override, not the .env port", async () => {
  const hold = net.createServer();
  await new Promise((resolve) => hold.listen(0, "127.0.0.1", resolve));
  const busy = hold.address().port;
  try {
    const r = probed(dotenv, { CANON_PORT: String(busy) });
    assert.equal(r.server, busy);
    assert.match(r.out, new RegExp(`warn  port ${busy} busy \\(server\\)`));
  } finally {
    await new Promise((resolve) => hold.close(resolve));
  }
});

function pick({ server, web }) {
  return { server, web };
}
