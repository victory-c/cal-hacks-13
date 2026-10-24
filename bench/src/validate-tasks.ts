// For Edan: `npm run validate -w bench` checks every file in bench/tasks/ and says exactly what
// to fix. No server, no keys. Exit code 1 when anything is wrong.

import { loadTasks, TASKS_DIR, EXAMPLE_ID } from "./tasks.ts";

const TARGET = 20;

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
  console.log(`\n${real} of ${TARGET} tasks written (plus the example) in ${TASKS_DIR}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  console.error("\nFix the problems above, then run `npm run validate -w bench` again. Format: bench/tasks/README.md");
  process.exit(1);
}
