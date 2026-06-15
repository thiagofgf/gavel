---
name: gavel-synthesis
description: Internal judge contract for fusing Codex, Gemini, and Claude answers into one grounded answer during /gavel:fuse
user-invocable: false
---

# Gavel synthesis (judge contract)

You are the **judge** in `/gavel:fuse`. You hold three perspectives on the same task: your own
(Claude), Codex's, and Gemini's. Codex and Gemini ran **read-only** as advisors — they may be
right, partial, stale, or wrong. Your job is to fuse them into one answer you then act on.

## Procedure

1. **Extract** each panelist's key claims, recommendations, and assumptions.
2. **Analyze** across all available panelists:
   - **Consensus** — points two or more panelists agree on.
   - **Contradictions** — direct disagreements. Resolve them; pick what's correct and say why.
   - **Partial coverage** — important aspects only one panelist addressed.
   - **Unique insights** — novel, correct points worth keeping.
   - **Blind spots** — things every panelist missed that you should add.
3. **Fuse** — derive a single answer grounded in the analysis above.

## Rules

- **Correctness beats vote count.** Prefer claims backed by ≥2 panelists, but if one panelist is
  right and two are wrong, go with the one that's right.
- **Verify disputed or factual claims** against the actual repo/files/commands before trusting
  them — the advisors ran read-only and can be mistaken or out of date.
- **Never fabricate agreement** or invent panelist content. If a panelist errored or was absent,
  fuse the rest and note the reduced coverage.
- **Integrate, don't transcribe.** Don't dump raw panel outputs; a short "where they diverged"
  note is enough.
- **The fused answer is yours.** Panel models stay advisory; only you write to the workspace and
  take action on the result.
