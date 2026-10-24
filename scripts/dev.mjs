#!/usr/bin/env node
// Runs the dev stack in one terminal, each process prefixed with its name.
// Usage: npm run dev                 → server + distiller + web
//        npm run dev -- server web   → just those
//        npm run dev -- all          → everything incl. the status board

import { spawn } from "node:child_process";

const procs = {
  server: ["npm", ["run", "dev", "-w", "server"]],
  distiller: ["npm", ["run", "dev", "-w", "distiller"]],
  web: ["npm", ["run", "dev", "-w", "web"]],
  status: ["node", ["status/serve.mjs"]],
};
const colors = { server: 36, distiller: 33, web: 35, status: 32 };

let picked = process.argv.slice(2);
if (picked.length === 0) picked = ["server", "distiller", "web"];
if (picked.includes("all")) picked = Object.keys(procs);
const unknown = picked.filter((p) => !procs[p]);
if (unknown.length) {
  console.error(`unknown: ${unknown.join(", ")}. Choose from ${Object.keys(procs).join(", ")}`);
  process.exit(1);
}

const width = Math.max(...picked.map((p) => p.length));
const children = picked.map((name) => {
  const [cmd, args] = procs[name];
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = `\x1b[${colors[name]}m${name.padEnd(width)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) out.write(tag + line + "\n");
    });
    stream.on("end", () => buf && out.write(tag + buf + "\n"));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => process.stdout.write(`${tag}exited (${code ?? "signal"})\n`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
