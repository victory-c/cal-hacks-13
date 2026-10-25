// Tests for the doctor's pure checks (scripts/doctor.mjs). Importing the module runs nothing: the
// port scan and the exit code live behind the CLI guard, so these run offline in milliseconds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HOOK_SCRIPTS, checkAuthor, checkHookWiring, checkMcpJson, checkPersonToken, parseClientTokens, parseDotEnv } from "./doctor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const WORLD = JSON.parse(read("fixtures", "world", "world.json"));
const EXAMPLE = parseDotEnv(read(".env.example"));

test("parseDotEnv reads the flat .env format: comments, quotes, inline comments, CRLF", () => {
  assert.deepEqual(parseDotEnv('# c\r\nA=1\r\nB="x # y"\r\nC=v # tail\r\nD=\r\nnot a line\r\n'), { A: "1", B: "x # y", C: "v", D: "" });
  assert.deepEqual(parseDotEnv(undefined), {});
  assert.ok(EXAMPLE.CANON_CLIENT_TOKENS.includes("dollar-bill=dev-dollar-bill"), ".env.example still carries the dev tokens the server falls back to");
});

test("parseClientTokens mirrors shared/src/grants.ts: token → client, blanks and bad pairs skipped", () => {
  const map = parseClientTokens(" a=1, b = 2 ,=3,c=,d,, e=5=6");
  assert.deepEqual([...map], [["1", "a"], ["2", "b"], ["5=6", "e"]]);
  assert.equal(parseClientTokens(undefined).size, 0);
});

test("checkPersonToken: unset is silent; a person's token is ok; anything else fails and says which", () => {
  const principals = WORLD.principals;
  const tokens = EXAMPLE.CANON_CLIENT_TOKENS;
  assert.equal(checkPersonToken({ personToken: "", clientTokens: tokens, principals }), null);

  const bill = checkPersonToken({ personToken: "dev-dollar-bill", clientTokens: tokens, principals });
  assert.equal(bill.level, "ok");
  assert.match(bill.message, /person "dollar-bill"/);
  assert.doesNotMatch(bill.message, /dev-dollar-bill/, "the token value is never printed");

  const unknown = checkPersonToken({ personToken: "not-a-token", clientTokens: tokens, principals, tokensSource: "the dev tokens" });
  assert.equal(unknown.level, "FAIL");
  assert.match(unknown.message, /not a token value in the dev tokens/);
  assert.match(unknown.message, /401/);
  assert.doesNotMatch(unknown.message, /not-a-token/);

  const operator = checkPersonToken({ personToken: "dev-claude-code", clientTokens: tokens, principals });
  assert.equal(operator.level, "FAIL");
  assert.match(operator.message, /client "claude-code", which is not a principal/);

  const agent = checkPersonToken({ personToken: "t", clientTokens: "desk-assistant=t", principals });
  assert.equal(agent.level, "FAIL");
  assert.match(agent.message, /"desk-assistant", a agent principal, not a person/);

  // Defensive: a world without principals, or tokens of any shape, never throws.
  assert.equal(checkPersonToken({ personToken: "t", clientTokens: "x=t", principals: undefined }).level, "FAIL");
  assert.equal(checkPersonToken({ personToken: "t", clientTokens: undefined, principals }).level, "FAIL");
});

test("checkAuthor warns only when neither CANON_PERSON_TOKEN nor CANON_PRINCIPAL is set", () => {
  const r = checkAuthor({ personToken: "", principal: "" });
  assert.equal(r.level, "warn");
  assert.match(r.message, /captures will have no author/);
  assert.equal(checkAuthor({ personToken: "dev-ben", principal: "" }), null);
  assert.equal(checkAuthor({ personToken: "", principal: "ben" }), null);
});

test("checkMcpJson: the committed .mcp.json passes; missing, malformed or token-holding files fail", () => {
  const real = checkMcpJson(read(".mcp.json"));
  assert.equal(real.level, "ok", real.message);

  assert.equal(checkMcpJson(undefined).level, "FAIL");
  assert.match(checkMcpJson(undefined).message, /missing/);
  assert.match(checkMcpJson("{ nope").message, /does not parse/);
  assert.match(checkMcpJson(JSON.stringify({ mcpServers: { other: {} } })).message, /no mcpServers\.bullwark/);

  const literal = { mcpServers: { bullwark: { type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer dev-dollar-bill" } } } };
  const r = checkMcpJson(JSON.stringify(literal));
  assert.equal(r.level, "FAIL");
  assert.match(r.message, /never a literal token/);
  assert.doesNotMatch(r.message, /dev-dollar-bill/);

  const wrong = { mcpServers: { bullwark: { type: "stdio", url: "http://127.0.0.1:4100", headers: { Authorization: "Bearer ${CANON_PERSON_TOKEN}" } } } };
  const w = checkMcpJson(JSON.stringify(wrong));
  assert.equal(w.level, "FAIL");
  assert.match(w.message, /type is "stdio"/);
  assert.match(w.message, /end with \/mcp/);
});

test("checkHookWiring: the committed .claude/settings.json wires all three events; gaps and the bare $CLAUDE_PROJECT_DIR are named", () => {
  const settings = JSON.parse(read(".claude", "settings.json"));
  const real = checkHookWiring(settings);
  assert.deepEqual(real.map((r) => r.level), ["ok", "ok", "ok"], JSON.stringify(real));
  assert.deepEqual(Object.keys(HOOK_SCRIPTS), ["Stop", "SessionEnd", "UserPromptSubmit"]);
  for (const [i, [event, script]] of Object.entries(HOOK_SCRIPTS).entries()) assert.equal(real[i].message, `.claude/settings.json: ${event} → ${script}`);

  const entry = (command, timeout) => [{ hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }] }];
  const bare = checkHookWiring({ hooks: { ...settings.hooks, Stop: entry('node "$CLAUDE_PROJECT_DIR/hooks/claude-code/canon-capture.mjs"', 15) } });
  assert.equal(bare[0].level, "warn");
  assert.match(bare[0].message, /Stop uses the bare \$CLAUDE_PROJECT_DIR/);

  const missing = checkHookWiring({ hooks: { Stop: settings.hooks.Stop, SessionEnd: settings.hooks.SessionEnd } });
  assert.equal(missing[2].level, "FAIL");
  assert.match(missing[2].message, /UserPromptSubmit does not run hooks\/claude-code\/canon-context\.mjs/);

  const swapped = checkHookWiring({ hooks: { ...settings.hooks, UserPromptSubmit: settings.hooks.Stop } });
  assert.equal(swapped[2].level, "FAIL", "the capture script on UserPromptSubmit is not the context hook");

  const noTimeout = checkHookWiring({ hooks: { ...settings.hooks, SessionEnd: entry('node "${CLAUDE_PROJECT_DIR}/hooks/claude-code/canon-capture.mjs"', undefined) } });
  assert.equal(noTimeout[1].level, "warn");
  assert.match(noTimeout[1].message, /no timeout/);

  assert.equal(checkHookWiring({}).length, 1);
  assert.equal(checkHookWiring({})[0].level, "FAIL");
  assert.equal(checkHookWiring(null)[0].level, "FAIL");
});
