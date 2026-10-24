// For Edan: `npm run validate -w bench` checks every file in bench/tasks/ (v1 handoff tasks) and
// bench/tasks/finance/ (A8 finance cases) and says exactly what to fix. No server, no keys.
// Exit code 1 when anything is wrong.

import { loadCases, FINANCE_CASES_DIR } from "./finance/cases.ts";
import { TARGET_ATTACKS, TARGET_TASKS } from "./finance/types.ts";
import { loadTasks, TASKS_DIR, EXAMPLE_ID } from "./tasks.ts";

const TARGET = 20;

let failed = false;

try {
  const { tasks, warnings } = loadTasks({ includeExample: true });
  for (const t of tasks) {
    const messages = t.setup_sessions.reduce((n, s) => n + s.messages.length, 0);
    console.log(
      `ok  ${t.id.padEnd(28)} ${t.from_client} → ${t.to_client}  folder ${t.folder}  ${t.setup_sessions.length} session(s), ${messages} message(s), ${t.answer_key.must_include.length} must_include${t.answer_key.must_not_include?.length ? `, ${t.answer_key.must_not_include.length} must_not_include` : ""}`,
    );
  }
  for (const w of warnings) console.warn(`warn ${w}`);
  const real = tasks.filter((t) => t.id !== EXAMPLE_ID).length;
  console.log(`\n${real} of ${TARGET} v1 handoff tasks written (plus the example) in ${TASKS_DIR}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  failed = true;
}

try {
  const { cases, warnings } = loadCases({ includeExamples: true });
  for (const c of cases) {
    const extra =
      c.kind === "task"
        ? `${c.needed_fact_ids?.length ?? 0} needed fact(s), ${c.answer_key?.must_include.length ?? 0} must_include`
        : `${c.attack_style}, ${c.leak_probes?.length ?? 0} probe(s)${c.agent ? ", creates an agent" : ""}${c.setup_sessions ? `, ${c.setup_sessions.length} session(s)` : ""}`;
    console.log(`ok  ${c.id.padEnd(30)} ${c.kind.padEnd(6)} ${c.principal.padEnd(6)} ${extra}`);
  }
  for (const w of warnings) console.warn(`warn ${w}`);
  const real = cases.filter((c) => !/^(?:task|attack)-00-/.test(c.id));
  const tasks = real.filter((c) => c.kind === "task").length;
  const attacks = real.length - tasks;
  console.log(`\n${tasks} of ${TARGET_TASKS} finance tasks and ${attacks} of ${TARGET_ATTACKS} attacks written (plus the examples) in ${FINANCE_CASES_DIR}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  failed = true;
}

if (failed) {
  console.error("\nFix the problems above, then run `npm run validate -w bench` again. Formats: bench/tasks/README.md and bench/tasks/finance/README.md");
  process.exit(1);
}
