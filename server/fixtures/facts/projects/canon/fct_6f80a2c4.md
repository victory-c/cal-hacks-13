---
id: fct_6f80a2c4
statement: "Canon's MCP server exposes four tools: canon_context, canon_search, canon_save and canon_whoami, each scoped to the client token's folders"
folder: projects/canon
tier: hot
jev_keep: 0.86
source: { client: claude-code, session: ses_de0001 }
updated: 2026-10-23
---
Streamable HTTP at `/mcp`, stateless (fresh server per request). Grants: claude-code reads projects/ and career/, chatgpt reads career/, nothing external reads private/.
