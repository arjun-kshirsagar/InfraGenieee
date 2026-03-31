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
- **Don't loop.** If stuck after 2–3 genuine attempts, block the task with a specific reason for the human instead of spinning.
- **Verify before completing:** `npm run build` + `npm run lint` pass; browser-test real flows (Playwright/Chromium is installed).

## Repo
`Vishesh-Paliwal/InfraGenieee` — the only repo agents may push to.
