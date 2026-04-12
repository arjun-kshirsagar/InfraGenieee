/**
 * InfraGenie — deterministic architecture-section generator (Feature 1, backend).
 *
 * Pure function: same `QuestionnaireAnswers` in → same `ArchitectureSection`
 * out. No `Date.now()`, no `Math.random()`, no network, no I/O. Determinism is
 * contract guarantee #1 (docs/api-contracts.md) and is unit-tested.
 *
 * This module composes B1's `recommendInfrastructure` (do NOT reimplement its
 * rules) with derived architecture: a pattern, a component list, an augmented
 * data model with inferred relationships, a CRUD-plus-auth API surface, and a
 * Mermaid flowchart the frontend renders verbatim.
 *
 * Owned by: backend. Consumes the architect-owned contract in `@/types/prd`.
 */

import type {
  ApiEndpoint,
  ArchitectureComponent,
  ArchitectureSection,
  Entity,
  EntityField,
  QuestionnaireAnswers,
  Relationship,
} from '@/types/prd';
import { recommendInfrastructure } from './infra';

/* -------------------------------------------------------------------------- */
/* Naive-but-documented helpers                                               */
/* -------------------------------------------------------------------------- */

/**
 * Naive English pluraliser for API paths. Intentionally simple — the rules are
 * documented here rather than inlined so the behaviour is reviewable and
 * testable:
 *   - a word ending in a consonant + `y` → `…ies` (Company → Companies)
 *   - a word ending in s/x/z/ch/sh → `…es`  (Address → Addresses)
 *   - otherwise → `…s`                        (Order → Orders)
 * Then lower-cased for the URL segment.
 */
export function pluralize(word: string): string {
  const w = word.trim();
  if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
  return `${w}s`;
}

/** URL-path segment for an entity: pluralised and lower-cased. */
export function entityPathSegment(entityName: string): string {
  return pluralize(entityName).toLowerCase();
}

/**
 * Sanitise an arbitrary name into a Mermaid-safe node id: alphanumeric only,
 * runs of anything else collapsed to `_`. Mermaid node ids cannot contain
 * spaces, quotes, or punctuation, so we strip them here rather than risk a
 * syntax error in the string the frontend renders.
 */
export function mermaidNodeId(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'node';
}

/** Escape a human label for use inside a Mermaid `["…"]` node body. */
function mermaidLabel(label: string): string {
  // Mermaid breaks on raw quotes/brackets inside a label; replace with safe
  // equivalents. Deterministic and lossy-but-legible.
  return label.replace(/["[\]{}|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* -------------------------------------------------------------------------- */
/* Data model — pass through user entities, augment auth/tenant entities      */
/* -------------------------------------------------------------------------- */

const USER_ENTITY_NAMES = ['user', 'account'];
const TENANT_ENTITY_NAMES = ['organization', 'organisation', 'workspace', 'tenant'];

function hasEntityNamed(entities: Entity[], names: string[]): boolean {
  return entities.some((e) => names.includes(e.name.trim().toLowerCase()));
}

/**
 * Build the augmented entity list. User-supplied entities and their fields are
 * passed through untouched (never renamed, reordered, or dropped). We only
 * *append*: a `User` when auth is required and no User/Account exists, and an
 * `Organization` when multi-tenant and no tenant-like entity exists.
 */
function buildEntities(answers: QuestionnaireAnswers): Entity[] {
  const { dataModel, auth } = answers;
  // Shallow copy the array; entities themselves are passed by reference so
  // their fields survive verbatim (asserted in tests).
  const entities: Entity[] = [...dataModel.entities];

  if (auth.authRequired && !hasEntityNamed(entities, USER_ENTITY_NAMES)) {
    const userFields: EntityField[] = [
      { name: 'email', type: 'string', required: true },
      { name: 'name', type: 'string', required: false },
      { name: 'passwordHash', type: 'string', required: false },
      { name: 'createdAt', type: 'date', required: true },
    ];
    entities.push({
      name: 'User',
      description: 'An authenticated account (auto-added because authentication is required).',
      fields: userFields,
    });
  }

  if (auth.multiTenant && !hasEntityNamed(entities, TENANT_ENTITY_NAMES)) {
    const orgFields: EntityField[] = [
      { name: 'name', type: 'string', required: true },
      { name: 'slug', type: 'string', required: true },
      { name: 'createdAt', type: 'date', required: true },
    ];
    entities.push({
      name: 'Organization',
      description: 'A tenant/organisation (auto-added because the product is multi-tenant).',
      fields: orgFields,
    });
  }

  return entities;
}

/** The tenant entity name present in the augmented list, if any. */
function tenantEntityName(entities: Entity[]): string | null {
  const match = entities.find((e) => TENANT_ENTITY_NAMES.includes(e.name.trim().toLowerCase()));
  return match ? match.name : null;
}

/**
 * Infer relationships from field names. A field is treated as a foreign key
 * when it is typed `relation`, or when its name is `<entity>Id` / `<entity>_id`
 * matching another entity (case-insensitive). Each such field yields a
 * `one-to-many` from the referenced (parent) entity to the entity that holds
 * the field (child). When multi-tenant, every non-tenant, non-User entity also
 * gets a `one-to-many` from the tenant entity.
 *
 * Every endpoint of every emitted relationship is guaranteed to be a name
 * present in `entities` — asserted in tests.
 */
function buildRelationships(entities: Entity[], multiTenant: boolean): Relationship[] {
  const relationships: Relationship[] = [];
  const seen = new Set<string>(); // dedupe by `${from}->${to}`

  // Lower-cased name → canonical name, for FK target resolution.
  const byLower = new Map<string, string>();
  for (const e of entities) byLower.set(e.name.trim().toLowerCase(), e.name);

  const add = (from: string, to: string, description: string) => {
    if (from === to) return; // no self-links from FK inference
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    relationships.push({ from, to, kind: 'one-to-many', description });
  };

  /** Resolve a foreign-key field name like `warehouseId` to a known entity. */
  const resolveFk = (fieldName: string): string | null => {
    const m = fieldName.trim().match(/^(.*?)(?:_id|Id)$/);
    if (!m || !m[1]) return null;
    const base = m[1].toLowerCase();
    return byLower.get(base) ?? null;
  };

  for (const child of entities) {
    for (const field of child.fields) {
      if (field.type === 'relation') {
        // A `relation` field: resolve its target by the field name if possible,
        // otherwise skip (we never invent an endpoint that isn't an entity).
        const target = resolveFk(field.name) ?? byLower.get(field.name.trim().toLowerCase());
        if (target && target !== child.name) {
          add(target, child.name, `Inferred from ${child.name}.${field.name} (relation field).`);
        }
        continue;
      }
      const target = resolveFk(field.name);
      if (target && target !== child.name) {
        add(target, child.name, `Inferred from foreign-key field ${child.name}.${field.name}.`);
      }
    }
  }

  if (multiTenant) {
    const tenant = tenantEntityName(entities);
    if (tenant) {
      for (const e of entities) {
        const isUser = USER_ENTITY_NAMES.includes(e.name.trim().toLowerCase());
        if (e.name === tenant || isUser) continue;
        add(tenant, e.name, `Every ${e.name} belongs to a ${tenant} (multi-tenant isolation).`);
      }
    }
  }

  return relationships;
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

/** Human labels for the external integrations, reused for components + prose. */
const INTEGRATION_TECH: Record<string, { label: string; technology: string }> = {
  payments: { label: 'Payments', technology: 'Stripe' },
  'transactional-email': { label: 'Transactional email', technology: 'Resend / Postmark' },
  'file-storage': { label: 'File storage', technology: 'S3-compatible object storage' },
  search: { label: 'Search', technology: 'Typesense / Algolia' },
  analytics: { label: 'Analytics', technology: 'PostHog' },
  'llm-api': { label: 'LLM API', technology: 'OpenAI / Anthropic API' },
  webhooks: { label: 'Webhooks', technology: 'Outbound webhook dispatcher' },
  maps: { label: 'Maps', technology: 'Mapbox / Google Maps' },
  sms: { label: 'SMS', technology: 'Twilio' },
};

function buildComponents(
  answers: QuestionnaireAnswers,
  infra: ArchitectureSection['infrastructure'],
): ArchitectureComponent[] {
  const { stack, scale, integrations, basics } = answers;
  const components: ArchitectureComponent[] = [];

  const bigScale = scale.userScale === 'large' || scale.userScale === 'very-large';
  const globalEdge = scale.regions.includes('global-edge');

  // Client — unless the frontend is explicitly 'none' (headless API).
  if (stack.frontend !== 'none') {
    const frontendTech =
      stack.frontend === 'react-spa'
        ? 'React SPA'
        : stack.frontend === 'svelte'
          ? 'SvelteKit'
          : stack.frontend === 'vue'
            ? 'Vue / Nuxt'
            : 'Next.js (App Router) + React';
    components.push({
      name: 'Web Client',
      kind: 'client',
      responsibility: 'Renders the UI and calls the API; holds no secrets.',
      technology: frontendTech,
    });
  }

  // Service — the API, always present.
  const backendTech =
    stack.backend === 'node-express'
      ? 'Node.js + Express'
      : stack.backend === 'nestjs'
        ? 'NestJS'
        : stack.backend === 'python-fastapi'
          ? 'Python + FastAPI'
          : stack.backend === 'go'
            ? 'Go (net/http)'
            : 'Next.js API routes (App Router route handlers)';
  components.push({
    name: 'API Service',
    kind: 'service',
    responsibility: `Business logic and data access for ${basics.projectName}; validates every request and enforces auth.`,
    technology: backendTech,
  });

  // Datastore — unless the recommender returned no database.
  if (infra.database !== 'None') {
    components.push({
      name: 'Primary Datastore',
      kind: 'datastore',
      responsibility: 'System of record for all persistent entities.',
      technology: infra.database,
    });
  }

  // Cache — when the recommender provisioned one.
  if (infra.cache) {
    components.push({
      name: 'Cache',
      kind: 'cache',
      responsibility: 'Caches hot read paths and holds ephemeral session/rate-limit state.',
      technology: infra.cache,
    });
  }

  // Queue — when background jobs are needed.
  if (integrations.needsBackgroundJobs) {
    components.push({
      name: 'Job Queue',
      kind: 'queue',
      responsibility: 'Runs asynchronous and scheduled work off the request path.',
      technology: infra.cache ? 'BullMQ (Redis-backed)' : 'Managed queue (Upstash QStash / SQS)',
    });
  }

  // CDN — when serving global-edge regions or at large+ scale.
  if (globalEdge || bigScale) {
    const driver = globalEdge ? 'global-edge region' : `${scale.userScale} user scale`;
    components.push({
      name: 'CDN / Edge',
      kind: 'cdn',
      responsibility: `Serves static assets and caches responses at the edge (added for ${driver}).`,
      technology: infra.hosting.startsWith('AWS') ? 'Amazon CloudFront' : 'CDN (Cloudflare / Vercel Edge)',
    });
  }

  // External — one per integration, in the user's given order.
  for (const integ of integrations.integrations) {
    const meta = INTEGRATION_TECH[integ] ?? { label: integ, technology: integ };
    components.push({
      name: `${meta.label} (external)`,
      kind: 'external',
      responsibility: `Third-party ${meta.label.toLowerCase()} provider integrated server-side; credentials in env vars.`,
      technology: meta.technology,
    });
  }

  return components;
}

/* -------------------------------------------------------------------------- */
/* API endpoints                                                              */
/* -------------------------------------------------------------------------- */

const AUTH_ENDPOINT: Record<string, { path: string; purpose: string }> = {
  'email-password': { path: '/api/auth/login', purpose: 'Authenticate with email and password.' },
  'magic-link': { path: '/api/auth/magic-link', purpose: 'Request and consume a passwordless magic link.' },
  'oauth-google': { path: '/api/auth/oauth/google', purpose: 'Begin/complete Google OAuth sign-in.' },
  'oauth-github': { path: '/api/auth/oauth/github', purpose: 'Begin/complete GitHub OAuth sign-in.' },
  'sso-saml': { path: '/api/auth/saml', purpose: 'Enterprise SSO via SAML assertion.' },
  'api-keys': { path: '/api/auth/api-keys', purpose: 'Issue and manage machine API keys.' },
};

function buildApiEndpoints(answers: QuestionnaireAnswers, entities: Entity[]): ApiEndpoint[] {
  const { auth, integrations } = answers;
  const endpoints: ApiEndpoint[] = [];
  const authRequired = auth.authRequired;

  // Full CRUD per entity.
  for (const entity of entities) {
    const seg = entityPathSegment(entity.name);
    endpoints.push(
      { method: 'GET', path: `/api/${seg}`, purpose: `List ${entity.name} records.`, authRequired },
      { method: 'POST', path: `/api/${seg}`, purpose: `Create a ${entity.name}.`, authRequired },
      { method: 'GET', path: `/api/${seg}/:id`, purpose: `Fetch a single ${entity.name}.`, authRequired },
      { method: 'PATCH', path: `/api/${seg}/:id`, purpose: `Update a ${entity.name}.`, authRequired },
      { method: 'DELETE', path: `/api/${seg}/:id`, purpose: `Delete a ${entity.name}.`, authRequired },
    );
  }

  // Auth endpoints per configured method (auth endpoints are themselves public).
  if (auth.authRequired) {
    const methods = auth.authMethods.length > 0 ? auth.authMethods : ['email-password' as const];
    for (const method of methods) {
      const meta = AUTH_ENDPOINT[method] ?? { path: `/api/auth/${method}`, purpose: `Authenticate via ${method}.` };
      endpoints.push({ method: 'POST', path: meta.path, purpose: meta.purpose, authRequired: false });
    }
    endpoints.push({
      method: 'POST',
      path: '/api/auth/logout',
      purpose: 'Invalidate the current session.',
      authRequired: true,
    });
  }

  // Webhook receiver when payments or webhooks are integrated.
  if (integrations.integrations.includes('payments') || integrations.integrations.includes('webhooks')) {
    endpoints.push({
      method: 'POST',
      path: '/api/webhooks/:provider',
      purpose: 'Receive and verify inbound provider webhooks (signature-checked).',
      authRequired: false,
    });
  }

  return endpoints;
}

/* -------------------------------------------------------------------------- */
/* Pattern                                                                    */
/* -------------------------------------------------------------------------- */

/** Derive the architecture pattern and name the driver that chose it. */
function derivePattern(answers: QuestionnaireAnswers): string {
  const { stack, scale, basics } = answers;
  const bigScale = scale.userScale === 'large' || scale.userScale === 'very-large';
  const aggressive = scale.growthExpectation === 'aggressive';

  if (basics.productType === 'api-service') {
    return `Standalone API service (driver: productType "api-service")`;
  }
  if (bigScale || aggressive) {
    const driver = bigScale ? `${scale.userScale} user scale` : 'aggressive growth expectation';
    return `Containerised services behind a load balancer (driver: ${driver})`;
  }
  if (stack.backend === 'next-api-routes' || stack.backend === 'no-preference') {
    return `Monolithic Next.js app with API routes (driver: ${scale.userScale} scale on Next.js API routes)`;
  }
  const backendName =
    stack.backend === 'node-express'
      ? 'Node/Express'
      : stack.backend === 'nestjs'
        ? 'NestJS'
        : stack.backend === 'python-fastapi'
          ? 'FastAPI'
          : 'Go';
  return `Client + single ${backendName} API service (driver: explicit ${stack.backend} backend at ${scale.userScale} scale)`;
}

/* -------------------------------------------------------------------------- */
/* Mermaid diagram                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit a `flowchart TD` covering every component and its edges. Node ids are
 * sanitised so spaces/quotes can never break the frontend renderer. The graph:
 *   client → service, service → datastore/cache/queue/external, cdn → client.
 */
function buildMermaid(projectName: string, components: ArchitectureComponent[]): string {
  const lines: string[] = [];
  lines.push(`%% InfraGenie architecture diagram for ${mermaidLabel(projectName)}`);
  lines.push('flowchart TD');

  // Assign a deterministic, unique node id per component.
  const ids = new Map<ArchitectureComponent, string>();
  const usedIds = new Set<string>();
  for (const c of components) {
    const base = mermaidNodeId(c.name);
    let id = base;
    let i = 2;
    while (usedIds.has(id)) {
      id = `${base}_${i++}`;
    }
    usedIds.add(id);
    ids.set(c, id);
    lines.push(`  ${id}["${mermaidLabel(c.name)}"]`);
  }

  const first = (kind: ArchitectureComponent['kind']) => components.find((c) => c.kind === kind);
  const client = first('client');
  const service = first('service');
  const datastore = first('datastore');
  const cache = first('cache');
  const queue = first('queue');
  const cdn = first('cdn');

  const edge = (a?: ArchitectureComponent, b?: ArchitectureComponent, label?: string) => {
    if (!a || !b) return;
    const idA = ids.get(a)!;
    const idB = ids.get(b)!;
    lines.push(label ? `  ${idA} -->|${mermaidLabel(label)}| ${idB}` : `  ${idA} --> ${idB}`);
  };

  // CDN fronts the client if present.
  if (cdn && client) edge(cdn, client, 'edge cache');
  // Client talks to the API service.
  edge(client, service, 'HTTPS');
  // Service persists and caches.
  edge(service, datastore, 'read/write');
  edge(service, cache, 'cache');
  edge(service, queue, 'enqueue');
  // Service calls every external provider.
  for (const c of components) {
    if (c.kind === 'external') edge(service, c);
  }
  // Queue also touches the datastore when both exist.
  if (queue && datastore) edge(queue, datastore, 'process');

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

function buildSummary(
  answers: QuestionnaireAnswers,
  pattern: string,
  infra: ArchitectureSection['infrastructure'],
): string {
  const { scale, basics, auth } = answers;
  const patternName = pattern.split(' (driver:')[0];
  const driver =
    scale.userScale === 'very-large' || scale.userScale === 'large'
      ? `a ${scale.userScale} user base`
      : scale.growthExpectation === 'aggressive'
        ? 'aggressive growth expectations'
        : `a ${scale.userScale}-scale workload`;
  const tenancy = auth.multiTenant ? ' It is multi-tenant, so every query is scoped to an organisation.' : '';
  return (
    `${basics.projectName} adopts a ${patternName.toLowerCase()}, hosted on ${infra.hosting} with ${infra.database}. ` +
    `The design is sized for ${driver}, which is the biggest scale driver.${tenancy}`
  );
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn a completed questionnaire into the architecture section of the PRD.
 * Composes B1's infrastructure recommendation with a derived pattern,
 * component list, augmented data model, API surface, and Mermaid diagram.
 * Pure and deterministic.
 */
export function generateArchitectureSection(answers: QuestionnaireAnswers): ArchitectureSection {
  const infrastructure = recommendInfrastructure(answers);
  const pattern = derivePattern(answers);
  const components = buildComponents(answers, infrastructure);
  const entities = buildEntities(answers);
  const relationships = buildRelationships(entities, answers.auth.multiTenant);
  const apiEndpoints = buildApiEndpoints(answers, entities);
  const diagramMermaid = buildMermaid(answers.basics.projectName, components);
  const summary = buildSummary(answers, pattern, infrastructure);

  return {
    summary,
    pattern,
    components,
    dataModel: { entities, relationships },
    apiEndpoints,
    infrastructure,
    diagramMermaid,
  };
}
