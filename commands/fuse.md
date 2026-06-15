---
description: Ask Codex + Gemini + this Claude model in parallel, synthesize one fused answer, then act on it
argument-hint: "<task or question>"
---

You are running a **3-model fuse** for this request. You (the Claude Code model) are
**panelist #3, the judge, and the actor**. Codex and Gemini are **read-only advisors** — only you
write to the workspace or run side-effecting commands.

The task / question:
$ARGUMENTS

If the task is empty, ask the user what they want fused, then stop.

Follow these steps in order:

**1. Your own take.** Before consulting the panel, form your own answer/approach as the third
panelist. Read whatever files you need for context, but do **not** make final edits yet.

**2. Consult the panel.** Get the task to the advisors **without putting it in a shell command** (so
quotes, `$(...)`, or backticks in the task can't break the command or inject shell syntax):

- Use the **Write tool** to write the verbatim task text to a fresh temp file with a unique name,
  e.g. `/tmp/gavel-prompt-<timestamp>.txt`. Delete it afterward.
- Then run this — only the fixed file path is in the shell, never the task text:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gavel.mjs" fuse --cwd "$(pwd)" --prompt-file /tmp/gavel-prompt-XXXX.txt
```

Notes:
- Codex explores your repo **read-only**; Gemini runs in an **isolated sandbox and cannot see your
  files**, so put any code/snippets Gemini needs directly in the task text.
- If a panelist shows `[error]` because its CLI is missing/unauthenticated, continue with whoever
  responded and tell the user they can run `/gavel:setup`. If the panel is empty, stop and say so.

**3. Judge & synthesize.** Apply the **gavel-synthesis** skill to combine all three perspectives
(yours + Codex + Gemini): identify consensus, contradictions, partial coverage, unique insights,
and blind spots, then derive a **single fused answer**. Prefer claims supported by ≥2 panelists;
verify disputed/factual claims against the actual code; never invent agreement.

**4. Present & act.** Give a brief fused conclusion plus a short note on where the models agreed or
diverged. Then **take the appropriate action** grounded in the fused answer — make the edits, run
the commands, or deliver the final response. This "judge then acts" step is the point of the
command: don't stop at describing the answer when the task calls for doing it.
