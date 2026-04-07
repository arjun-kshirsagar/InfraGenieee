# Feature 1 — task graph

Decomposition of kanban task `t_91bbf500` (PRD & Plan Generator). Kept here so
any agent can see the whole shape without querying the board.

```
                    t_91bbf500  architect — contract + scaffolding (done)
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
  B1 t_80676606                   F1 t_8888f50b
  backend                         frontend
  infra recommender               store.ts + wizard shell
  + PRD section                   + autosave + home page
        │                              │
   ┌────┴─────┐                        ▼
   ▼          ▼                    F2 t_be48b99b
B2 t_68ecccb3  B3 t_27513104       frontend
architecture   plan / tasks        question field renderer
+ Mermaid      + criticalPath      + entity builder
   │          │                        │
   └────┬─────┘                        │
        ▼                              │
  B4 t_696dcb60 ─────────┬─────────────┤
  backend                │             │
  POST /api/prd/generate │             ▼
  + document composition │        F3 t_0496c50c
                         │        frontend
                         │        validation + submit
                         ▼        + error mapping
                    F4 t_aa6a3c37       │
                    frontend            │
                    /prd/[id] view      │
                    + markdown export   │
                         │              │
                         └──────┬───────┘
                                ▼
                          R1 t_63741569
                          reviewer
                          review + browser QA
                          → spawns fix tasks
```

Parallelism: the backend chain (B1→B2/B3→B4) and the frontend chain
(F1→F2) run independently — both only need the contract, which is already
merged. They converge at F3 and F4. Max 2 agents run concurrently.

## Contract ownership

| Path | Owner | Others |
|---|---|---|
| `src/types/prd.ts` | architect | read-only |
| `src/lib/prd/questionnaire.ts` | architect | read-only |
| `src/lib/prd/api.ts` | architect | read-only |
| `docs/*.md` | architect | reviewer appends `qa-feature-1.md` |
| `src/lib/prd/generate/**` | backend | frontend must NOT import |
| `src/app/api/**` | backend | — |
| `src/lib/prd/store.ts`, `src/components/prd/**`, `src/app/prd/**` | frontend | — |

A worker needing a contract change comments on `t_91bbf500` and blocks. Nobody
forks the types.
