// The committed .mcp.json at the repo root: Claude Code's Bullwark MCP connector. It must read the
// person's token from the shell environment and never hold one, and install.mjs --mcp must print
// the equivalent user-scope command.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { MCP_DEFAULT_URL, MCP_DEV_TOKEN, MCP_SERVER_NAME, TOKEN_PLACEHOLDER, mcpAddCommand } from "../claude-code/install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const text = readFileSync(join(ROOT, ".mcp.json"), "utf8");

test(".mcp.json: one http server named bullwark at ${CANON_URL}/mcp, Authorization from CANON_PERSON_TOKEN, no literal token", () => {
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ["mcpServers"]);
  assert.deepEqual(Object.keys(parsed.mcpServers), [MCP_SERVER_NAME]);
  const server = parsed.mcpServers.bullwark;
  assert.deepEqual(Object.keys(server).sort(), ["headers", "type", "url"]);
  assert.equal(server.type, "http");
  assert.ok(server.url.endsWith("/mcp"), server.url);
  assert.equal(server.url, `\${CANON_URL:-${MCP_DEFAULT_URL}}/mcp`, "Claude Code expands ${VAR:-default} in url and headers");

  const auth = server.headers.Authorization;
  assert.match(auth, /^Bearer \$\{CANON_PERSON_TOKEN/, "the header references ${CANON_PERSON_TOKEN");
  assert.equal(auth, `Bearer \${CANON_PERSON_TOKEN:-${MCP_DEV_TOKEN}}`, "the only default is the dev operator token (scaffold folders, nobody's scope)");
  assert.doesNotMatch(auth, /^Bearer [^$]/, "no literal token after Bearer");
  assert.doesNotMatch(text, /dev-(wags|axe|ben|dollar-bill)/, "no person's token in a committed file");
});

test("mcpAddCommand prints the same connector for `claude mcp add` at user scope, placeholder unless a token is given", () => {
  const parsed = JSON.parse(text);
  const cmd = mcpAddCommand();
  assert.equal(cmd, `claude mcp add --transport http bullwark --scope user "${MCP_DEFAULT_URL}/mcp" --header "Authorization: Bearer \${CANON_PERSON_TOKEN}"`);
  assert.ok(cmd.includes(`--transport ${parsed.mcpServers.bullwark.type}`));
  assert.ok(cmd.includes(TOKEN_PLACEHOLDER));
  assert.equal(mcpAddCommand({ url: "http://canon.example:4100/", token: "tok" }), 'claude mcp add --transport http bullwark --scope user "http://canon.example:4100/mcp" --header "Authorization: Bearer tok"');
});
