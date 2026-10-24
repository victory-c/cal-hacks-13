# Writing benchmark tasks (for Edan)

This folder is yours. Target: **20 task files** named `t01-….json` … `t20-….json`. Henry runs
them with `npm run run -w bench`; the numbers that come out are the only ones we may quote.

Check your work any time, no server or keys needed:

```bash
npm run validate -w bench
```

It prints one `ok` line per task, or tells you the file and field to fix.

## What a handoff task is

A student did some work in one AI (the **from** AI) and later opens a different AI (the **to**
AI) and asks something that needs that earlier context. Example: they wrote resume bullets about
an internship in ChatGPT; a week later, in Claude Code, they ask "which company did I intern at
and what was the headline result?" A good task has:

- **setup sessions**: 1–3 short, realistic transcripts from the from-AI (4–10 messages each).
  This is the only place the answer can come from.
- **a question** the student types in the to-AI, worded naturally, not quoting the transcript.
- **an answer key**: the exact phrases a right answer must contain.

Content: real **student recruiting** life. Internship bullets, offer deadlines, interview prep
notes, recruiter emails, which companies they applied to, a project they built, a class they took,
a return-offer decision. Invent people and companies freely, but keep it plausible. No real
classmates' private details.

Make some tasks where the right answer is **not** in the setup sessions (the correct answer is
"I don't have that"): put the phrase you expect, e.g. `"don't have"`, in `must_include`.

## The fields

| Field | What to put |
|---|---|
| `id` | Exactly the file name without `.json`, e.g. `t03-offer-deadline` |
| `title` | One line a judge can read |
| `from_client` | Where the context was made: `chatgpt`, `claude-code` or `teammate-cursor`. Only these three have a token and folder grants on the demo server; any other value (e.g. `claude-web`, `gemini-web`, `cursor`) validates but fails the canon run with "No token for client" |
| `to_client` | Where the question is asked, same three values. Must differ from `from_client` |
| `folder` | Where the facts belong: `career`, `career/projects`, `projects`, `team`. The to-AI must be allowed to read it: `claude-code` reads `projects` and `career`; `chatgpt` reads `career`; `teammate-cursor` reads `team`. Nothing reads `private` |
| `setup_sessions` | List of sessions (below) |
| `question` | What the student types in the to-AI |
| `answer_key` | `must_include`: phrases that must appear. `must_not_include` (optional): phrases that must not |
| `notes` | Optional: what this task tests, what you expect each baseline to do |

**A session** has `id`, `client` (same as `from_client`), `title` (optional), `started_at`,
`ended_at` (optional, ISO timestamps like `"2026-10-20T18:30:00Z"`), and `messages`: a list of
`{ "role": "user" | "assistant", "content": "..." }`.

**Session ids** look like `ses_` followed by hex digits (0–9, a–f) and must be unique across
**all** task files. Easiest: task number + counter, so task `t07` uses `ses_07000001`,
`ses_07000002`, …

## Writing answer keys

- Matching is a case-insensitive "contains". `"Databricks"` matches "at databricks,". `"30%"`
  matches "30%" but not "30 percent", so pick phrases with one obvious spelling.
- Use 2–4 `must_include` phrases: the specific facts (company, team, number, date), not whole
  sentences. Avoid phrases that could appear by accident ("the", "yes").
- `must_not_include` catches two failures: an answer that dumps unrelated context (a deadline from
  a different session when the question was about an internship) and a leak from `private/`.
- Before saving, read the question and the key as a stranger: could a short, correct answer miss a
  phrase? Then loosen the key.

## File naming and checklist

File: `tNN-short-slug.json`, two digits, lowercase words with dashes. `t00-example.json` is the
example and never counts toward the 20.

- [ ] `id` equals the file name without `.json`
- [ ] `from_client` ≠ `to_client`, both from `chatgpt` / `claude-code` / `teammate-cursor`, and the to-AI may read `folder` (table above)
- [ ] Every session's `client` equals `from_client`
- [ ] Session ids unique across all files (`npm run validate -w bench` checks)
- [ ] The answer is actually in the setup sessions (or the task is a deliberate "not there")
- [ ] 2–4 `must_include` phrases with one obvious spelling
- [ ] Transcripts sound like a real student, 4–10 messages each
- [ ] `npm run validate -w bench` says `ok`

## Full example

This is `t00-example.json` in this folder. Copy it, rename it, change everything.

```json
{
  "id": "t00-example",
  "title": "Internship headline: written up in ChatGPT, needed in Claude Code",
  "from_client": "chatgpt",
  "to_client": "claude-code",
  "folder": "career",
  "setup_sessions": [
    {
      "id": "ses_00000001",
      "client": "chatgpt",
      "title": "Resume bullets for my Databricks internship",
      "started_at": "2026-09-14T19:02:00Z",
      "ended_at": "2026-09-14T19:21:00Z",
      "messages": [
        { "role": "user", "content": "Help me write resume bullets. Last summer (June to August 2026) I was a software engineering intern at Databricks on the Spark SQL team in San Francisco. I rewrote the join reordering heuristic in the query planner and cut median planning latency by 30% on the TPC-DS suite. The change shipped to all customers in the 17.1 release." },
        { "role": "assistant", "content": "Here are three bullets:\n- Rewrote the join reordering heuristic in Spark SQL's query planner, cutting median planning latency 30% on TPC-DS; shipped to all customers in Databricks Runtime 17.1.\n- Profiled planner hot paths across 99 TPC-DS queries to find the regression class the heuristic missed.\n- Added planner micro-benchmarks to CI so future heuristic changes are measured, not guessed." },
        { "role": "user", "content": "Make the first one shorter, and start with the result." },
        { "role": "assistant", "content": "- Cut Spark SQL planning latency 30% (median, TPC-DS) by rewriting join reordering; shipped in Databricks Runtime 17.1." }
      ]
    },
    {
      "id": "ses_00000002",
      "client": "chatgpt",
      "title": "Which recruiting deadlines to prioritize",
      "started_at": "2026-10-02T02:15:00Z",
      "ended_at": "2026-10-02T02:24:00Z",
      "messages": [
        { "role": "user", "content": "I'm a junior at UC Berkeley studying CS, graduating May 2028, applying for summer 2027 software internships. Stripe's application closes October 31 and Jane Street's closes November 15. I can only do one well this week. Which should I prioritize?" },
        { "role": "assistant", "content": "Do Stripe this week: its deadline is two weeks earlier and its process starts with a take-home, which you can finish before Jane Street's online assessment opens. Put Jane Street on your calendar for the week of November 8." }
      ]
    }
  ],
  "question": "I'm updating the About section of my portfolio site. Which company did I intern at last summer, which team was it, and what was the headline result?",
  "answer_key": {
    "must_include": ["Databricks", "Spark SQL", "30%"],
    "must_not_include": ["Stripe", "Jane Street"]
  },
  "notes": "no-memory cannot answer; full-history answers but injects both sessions; canon should answer from session 1's career/ facts only. The must_not_include phrases catch a slice that is too wide."
}
```

## Ideas for the 20

Internship headline · return-offer deadline · which three companies they applied to · the
interview question they bombed and the fix · a professor's name for a recommendation letter ·
the GPA they decided to list · the project stack for the portfolio · a recruiter's name and the
promised follow-up date · which offer they accepted and why · relocation city · a negotiated
salary number · the hackathon they won · a class they are taking this term · a deliberately
unanswerable one · a question that only `private/` could answer (answer: not available).
