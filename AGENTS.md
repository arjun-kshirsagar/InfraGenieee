# InfraGenieee — Project Context for Agents

InfraGenie is a **pre-build & deploy companion** web app. We do NOT build the user's app for them — we plan it and help them ship it. Three features:

1. **PRD & Plan generator** — an interactive questionnaire that asks everything needed (scale, expected traffic, budget, stack preferences, data model, auth, integrations) BEFORE producing a PRD + architecture + task breakdown.
2. **Deployment cost predictor** — an interactive UI comparing estimated deployment costs across vendors (Vercel, AWS, Render, Fly.io, …), informed by the PRD context.
3. **One-click deploy** — lets InfraGenie's *customers* deploy *their own* app to the easiest applicable provider (Vercel first) via the provider's deploy API.

## Stack
Next.js (App Router) + TypeScript (strict) + Tailwind + shadcn/ui. Charts: Recharts. Forms: react-hook-form + zod.

## Ground rules for all agents
- **Commit and push often** to `origin/main` (or your task branch) with clear messages. Never leave work only in a scratch dir.
- **Coordinate via kanban comments.** Announce API contracts, decisions, and handoffs so teammates align.
- **Real data only.** Vendor pricing and third-party API behavior must be sourced (web_extract/web_search), never fabricated. Cite sources in code comments.
- **Shared contracts** live in `/docs` and `/types`. Backend + architect own them; frontend consumes them.
- **No hardcoded secrets.** Use server-side env vars.
- **Don't loop / don't blindly retry.** If a command (build, test, anything) fails or hangs, DO NOT just re-run it hoping it works. STOP and diagnose: read the actual error, find the root cause, and fix that cause. Re-running the same failing command unchanged is never the answer. If after genuine diagnosis + fix attempts (2–3) you still can't resolve it, `kanban_block` the task with the specific error and what you tried — for the human.
- **Verify before completing:** run `npm run build` (`next build`) AND `npm run lint` AND `npm test` — all must pass. The production build is the real gate; it catches issues typecheck alone misses. Also run `npx tsc --noEmit` for a fast early typecheck while developing.
- **If `npm run build` fails or hangs — diagnose, don't retry blindly:**
  - Read the error output. Fix real errors (type errors, bad imports, server/client boundary issues, missing deps) at the source.
  - If it fails with **"Another next build process is already running"**, that's a stale lock from a previously-killed build. Remove `.next/*.lock` (e.g. `rm -f .next/*.lock`) and any orphaned `next` process, then build again once.
  - If a build is genuinely slow, give it a real timeout (e.g. 6–8 min) rather than killing it early and creating a stale lock. Killing a build mid-run is what causes the lock problem — avoid it.
  - Never leave a `next build` / `next start` / `next dev` process running in the background when you finish; kill any server you started.
- **One task runs at a time** (concurrency capped at 1), so builds no longer collide — a clean build should succeed.

## Handoff: COMPLETE your task, do not BLOCK it
When your build task is finished and pushed, call `kanban_complete` — NOT `kanban_block`. `block` means "I am stuck / need input" and the dependency engine treats a blocked task as NOT done, which deadlocks any review/child task waiting on it. If a separate reviewer task exists, completing yours is what promotes the review to ready. Only use `block` when you genuinely cannot proceed (missing info, real error, needs owner approval). "Ready for review" is a COMPLETE, never a block.

## Repo
`Vishesh-Paliwal/InfraGenieee` — the only repo agents may push to.
