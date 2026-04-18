/**
 * InfraGenie — PRD document → Markdown serialiser (frontend-owned).
 *
 * `toMarkdown(doc)` is a PURE function: no DOM, no `window`, no I/O. It turns a
 * `PrdDocument` into a single readable Markdown document covering all three
 * sections (PRD / Architecture / Plan) plus the questionnaire answers that
 * produced it. It powers the "Copy as Markdown" and "Download .md" actions on
 * the document view, and is unit-tested in `markdown.test.ts`.
 *
 * Design rules:
 *   - Every field of `prdDocumentSchema` is represented.
 *   - Empty optional arrays produce NO dangling header (a section that would be
 *     empty is skipped entirely) — verified by tests.
 *   - Deterministic: same document in → same string out.
 */

import type {
  PrdDocument,
  QuestionnaireAnswers,
  Milestone,
  PlanTask,
  Entity,
} from '@/types/prd';

/** Join non-empty blocks with a blank line between them. */
function joinBlocks(blocks: Array<string | null | undefined>): string {
  return blocks.filter((b): b is string => Boolean(b && b.trim().length > 0)).join('\n\n');
}

/** Render a bullet list, or `null` if there is nothing to render. */
function bulletList(items: readonly string[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- ${i}`).join('\n');
}

/** A section: heading + body, but only if the body is non-empty. */
function section(heading: string, body: string | null | undefined): string | null {
  if (!body || body.trim().length === 0) return null;
  return `${heading}\n\n${body}`;
}

/** Render a markdown table from a header row and body rows. `null` if no rows. */
function table(headers: readonly string[], rows: readonly string[][]): string | null {
  if (rows.length === 0) return null;
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map(escape).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

/* -------------------------------------------------------------------------- */
/* PRD section                                                                */
/* -------------------------------------------------------------------------- */

function prdMarkdown(doc: PrdDocument): string {
  const { prd } = doc;
  const parts: Array<string | null> = [];

  parts.push('## Product Requirements');

  // Overview
  parts.push(
    section(
      '### Overview',
      joinBlocks([
        `**Problem**\n\n${prd.overview.problem}`,
        `**Solution**\n\n${prd.overview.solution}`,
        `**Target users**\n\n${prd.overview.targetUsers}`,
        section('**Value proposition**', bulletList(prd.overview.valueProposition)),
      ]),
    ),
  );

  parts.push(section('### Goals', bulletList(prd.goals)));
  parts.push(section('### Non-goals', bulletList(prd.nonGoals)));

  // User stories
  if (prd.userStories.length > 0) {
    const stories = prd.userStories
      .map((s) => {
        const ac = s.acceptanceCriteria.map((c) => `  - ${c}`).join('\n');
        return `- **${s.id}** \`${s.priority}\` — As a ${s.asA}, I want ${s.iWant}, so that ${s.soThat}.\n  - _Acceptance criteria:_\n${ac}`;
      })
      .join('\n');
    parts.push(section('### User stories', stories));
  }

  // Functional requirements
  parts.push(
    section(
      '### Functional requirements',
      table(
        ['ID', 'Priority', 'Title', 'Detail'],
        doc.prd.functionalRequirements.map((r) => [r.id, r.priority, r.title, r.detail]),
      ),
    ),
  );

  // Non-functional requirements, grouped by category
  if (prd.nonFunctionalRequirements.length > 0) {
    const categories = Array.from(new Set(prd.nonFunctionalRequirements.map((n) => n.category)));
    const groups = categories
      .map((cat) => {
        const rows = prd.nonFunctionalRequirements
          .filter((n) => n.category === cat)
          .map((n) => `- **${n.id}** — ${n.requirement}\n  - _Rationale:_ ${n.rationale}`)
          .join('\n');
        return `#### ${cat}\n\n${rows}`;
      })
      .join('\n\n');
    parts.push(section('### Non-functional requirements', groups));
  }

  parts.push(section('### Success metrics', bulletList(prd.successMetrics)));

  // Risks
  parts.push(
    section(
      '### Risks',
      table(
        ['Risk', 'Impact', 'Mitigation'],
        prd.risks.map((r) => [r.risk, r.impact, r.mitigation]),
      ),
    ),
  );

  parts.push(section('### Open questions', bulletList(prd.openQuestions)));

  return joinBlocks(parts);
}

/* -------------------------------------------------------------------------- */
/* Architecture section                                                       */
/* -------------------------------------------------------------------------- */

function entityBlock(entity: Entity): string {
  const header = `#### ${entity.name}`;
  const desc = entity.description ? entity.description : null;
  const fields = table(
    ['Field', 'Type', 'Required', 'Notes'],
    entity.fields.map((f) => [f.name, f.type, f.required ? 'yes' : 'no', f.notes ?? '']),
  );
  return joinBlocks([header, desc, fields ?? '_No fields defined._']);
}

function architectureMarkdown(doc: PrdDocument): string {
  const { architecture: arch } = doc;
  const parts: Array<string | null> = [];

  parts.push('## Architecture');
  parts.push(section('### Summary', `${arch.summary}\n\n**Pattern:** ${arch.pattern}`));

  // Components grouped by kind
  if (arch.components.length > 0) {
    const kinds = Array.from(new Set(arch.components.map((c) => c.kind)));
    const groups = kinds
      .map((kind) => {
        const rows = arch.components
          .filter((c) => c.kind === kind)
          .map((c) => `- **${c.name}** (${c.technology}) — ${c.responsibility}`)
          .join('\n');
        return `#### ${kind}\n\n${rows}`;
      })
      .join('\n\n');
    parts.push(section('### Components', groups));
  }

  // Data model
  const entityBlocks =
    arch.dataModel.entities.length > 0
      ? arch.dataModel.entities.map(entityBlock).join('\n\n')
      : null;
  const relationships = table(
    ['From', 'To', 'Kind', 'Description'],
    arch.dataModel.relationships.map((r) => [r.from, r.to, r.kind, r.description ?? '']),
  );
  parts.push(
    section(
      '### Data model',
      joinBlocks([
        entityBlocks,
        relationships ? section('#### Relationships', relationships) : null,
      ]),
    ),
  );

  // API endpoints
  parts.push(
    section(
      '### API endpoints',
      table(
        ['Method', 'Path', 'Purpose', 'Auth'],
        arch.apiEndpoints.map((e) => [e.method, e.path, e.purpose, e.authRequired ? 'yes' : 'no']),
      ),
    ),
  );

  // Infrastructure
  const infra = arch.infrastructure;
  const infraRows = table(
    ['Concern', 'Choice'],
    [
      ['Hosting', infra.hosting],
      ['Database', infra.database],
      ['Cache', infra.cache ?? '—'],
      ['Storage', infra.storage ?? '—'],
      ['CI/CD', infra.cicd],
      ['Environments', infra.environments.join(', ')],
    ],
  );
  parts.push(
    section(
      '### Infrastructure',
      joinBlocks([infraRows, section('#### Why this infrastructure', bulletList(infra.rationale))]),
    ),
  );

  // Mermaid diagram (fenced so it renders on GitHub etc.)
  parts.push(
    section('### Architecture diagram', `\`\`\`mermaid\n${arch.diagramMermaid}\n\`\`\``),
  );

  return joinBlocks(parts);
}

/* -------------------------------------------------------------------------- */
/* Plan section                                                               */
/* -------------------------------------------------------------------------- */

function planMarkdown(doc: PrdDocument): string {
  const { plan } = doc;
  const parts: Array<string | null> = [];

  // Map task id → title so dependsOn / criticalPath render as titles.
  const titleById = new Map<string, string>();
  for (const m of plan.milestones) {
    for (const t of m.tasks) titleById.set(t.id, t.title);
  }
  const titleOf = (id: string): string => titleById.get(id) ?? id;

  parts.push('## Delivery plan');
  parts.push(
    `**Total estimate:** ${plan.totalEstimateHours} h · **Calendar estimate:** ${plan.estimatedCalendarWeeks} weeks`,
  );

  const critical = new Set(plan.criticalPath);

  const renderTask = (t: PlanTask): string => {
    const flag = critical.has(t.id) ? ' ⚡' : '';
    const deps =
      t.dependsOn.length > 0
        ? `\n  - _Depends on:_ ${t.dependsOn.map(titleOf).join(', ')}`
        : '';
    const ac = t.acceptanceCriteria.map((c) => `    - ${c}`).join('\n');
    return `- **${t.id}${flag}** — ${t.title} \`${t.area}\` · ${t.estimateHours} h\n  - ${t.description}${deps}\n  - _Acceptance criteria:_\n${ac}`;
  };

  const renderMilestone = (m: Milestone): string => {
    const tasks = m.tasks.length > 0 ? m.tasks.map(renderTask).join('\n') : '_No tasks._';
    return `### ${m.name}\n\n_${m.goal}_\n\n${tasks}`;
  };

  if (plan.milestones.length > 0) {
    parts.push(plan.milestones.map(renderMilestone).join('\n\n'));
  }

  // Critical path as task titles
  if (plan.criticalPath.length > 0) {
    parts.push(
      section(
        '### Critical path',
        plan.criticalPath.map((id) => `- ${titleOf(id)}`).join('\n'),
      ),
    );
  }

  return joinBlocks(parts);
}

/* -------------------------------------------------------------------------- */
/* Answers echo                                                               */
/* -------------------------------------------------------------------------- */

function answersMarkdown(answers: QuestionnaireAnswers): string {
  const { basics, scale, budget, stack, dataModel, auth, integrations } = answers;
  const parts: Array<string | null> = [];

  parts.push('## Questionnaire answers');

  parts.push(
    section(
      '### Basics',
      bulletList([
        `Project name: ${basics.projectName}`,
        `One-liner: ${basics.oneLiner}`,
        `Product type: ${basics.productType}`,
        `Target audience: ${basics.targetAudience}`,
        `Problem statement: ${basics.problemStatement}`,
      ]),
    ),
  );

  parts.push(
    section(
      '### Scale & traffic',
      bulletList([
        `User scale: ${scale.userScale}`,
        `Peak requests/sec: ${scale.peakRequestsPerSecond}`,
        `Data volume: ${scale.dataVolumeGb} GB`,
        `Growth expectation: ${scale.growthExpectation}`,
        `Regions: ${scale.regions.join(', ')}`,
        `Uptime target: ${scale.uptimeTargetPercent}%`,
      ]),
    ),
  );

  parts.push(
    section(
      '### Budget & team',
      bulletList([
        `Monthly budget band: ${budget.monthlyBudgetBand}`,
        `Budget is a hard limit: ${budget.budgetIsHardLimit ? 'yes' : 'no'}`,
        `Team size: ${budget.teamSize}`,
        `Timeline: ${budget.timelineWeeks} weeks`,
      ]),
    ),
  );

  parts.push(
    section(
      '### Stack preferences',
      bulletList(
        [
          `Frontend: ${stack.frontend}`,
          `Backend: ${stack.backend}`,
          `Database: ${stack.database}`,
          `Hosting: ${stack.hosting}`,
          stack.mustUse.length > 0 ? `Must use: ${stack.mustUse.join(', ')}` : null,
          stack.mustAvoid.length > 0 ? `Must avoid: ${stack.mustAvoid.join(', ')}` : null,
        ].filter((x): x is string => x !== null),
      ),
    ),
  );

  // Data model answers (entities as blocks + relationship notes)
  const answerEntities =
    dataModel.entities.length > 0 ? dataModel.entities.map(entityBlock).join('\n\n') : null;
  parts.push(
    section(
      '### Data model',
      joinBlocks([
        answerEntities,
        dataModel.relationshipNotes
          ? `**Relationship notes:** ${dataModel.relationshipNotes}`
          : null,
      ]),
    ),
  );

  parts.push(
    section(
      '### Auth & compliance',
      bulletList(
        [
          `Auth required: ${auth.authRequired ? 'yes' : 'no'}`,
          auth.authMethods.length > 0 ? `Auth methods: ${auth.authMethods.join(', ')}` : null,
          auth.roles.length > 0 ? `Roles: ${auth.roles.join(', ')}` : null,
          `Multi-tenant: ${auth.multiTenant ? 'yes' : 'no'}`,
          auth.compliance.length > 0 ? `Compliance: ${auth.compliance.join(', ')}` : null,
        ].filter((x): x is string => x !== null),
      ),
    ),
  );

  parts.push(
    section(
      '### Integrations & workloads',
      bulletList(
        [
          integrations.integrations.length > 0
            ? `Integrations: ${integrations.integrations.join(', ')}`
            : null,
          `Needs realtime: ${integrations.needsRealtime ? 'yes' : 'no'}`,
          `Needs background jobs: ${integrations.needsBackgroundJobs ? 'yes' : 'no'}`,
          `Needs file uploads: ${integrations.needsFileUploads ? 'yes' : 'no'}`,
          integrations.notes ? `Notes: ${integrations.notes}` : null,
        ].filter((x): x is string => x !== null),
      ),
    ),
  );

  return joinBlocks(parts);
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Serialise a `PrdDocument` to a single readable Markdown string.
 * Pure — deterministic for a given document, no side effects.
 */
export function toMarkdown(doc: PrdDocument): string {
  const header = joinBlocks([
    `# ${doc.title}`,
    bulletList([
      `Document ID: \`${doc.id}\``,
      `Created: ${doc.createdAt}`,
      `Generator version: ${doc.generatorVersion}`,
    ]),
  ]);

  return (
    joinBlocks([
      header,
      prdMarkdown(doc),
      architectureMarkdown(doc),
      planMarkdown(doc),
      answersMarkdown(doc.answers),
    ]) + '\n'
  );
}
