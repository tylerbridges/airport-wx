## Output

Always keep replies brief: lead with the result, a few lines or bullets at most, no preamble or recap. Go longer only when I explicitly ask for depth, a comparison, or a write-up.

@AGENTS.md

<!-- orchestration-kit -->
## Orchestration kit
- Planner: main session (Opus 5.5 medium by default; Sonnet 5.5 for routine work on small app repos).
- Roles (in .claude/agents or ~/.claude/agents): extractor (Haiku), researcher (Sonnet), implementer (Sonnet), senior-implementer (Opus), verifier (Opus).
- Advisor: Opus (`/advisor opus`) for hard decisions, recurring errors, and pre-done checks; Fable advisor only on request. No planning subagent.
- auto-delegation: on (narrow): extractor/researcher for doc-heavy reading; implementer for 2+ independent pieces; verifier for risky diffs; senior-implementer only under a Sonnet main.
- Ask before >3 agents in a batch or any Fable use. Hard ceiling: 4 concurrent agents.
- Every brief is self-contained and includes the no-go list: sending, buying, booking, posting, deleting, creating calendar events. Subagents never spawn agents.
- Main session reviews every return before reporting done.
<!-- /orchestration-kit -->
