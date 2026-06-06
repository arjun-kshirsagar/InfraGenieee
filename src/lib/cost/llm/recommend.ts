/**
 * InfraGenie — Feature 2, the AI recommendation stage.
 *
 * SERVER-ONLY. Reads `ANTHROPIC_API_KEY` (indirectly, via `callStructured`) and
 * must NEVER be imported by a client component. The route (`/api/cost/recommend`)
 * is the only caller.
 *
 * ## What it does — and the split that makes it trustworthy
 *
 * `recommendDeployment` seeds the interactive cost selector: a STARTING POINT
 * the user can freely override, never a verdict. It follows the exact same
 * "the model reasons, TypeScript computes / verifies" split Feature 1 uses for
 * its Mermaid/graph derivation and the pricing layer uses for the evidence gate:
 *
 *   1. 🔴 `deriveUsageProfile(costContext)` FIRST, in TypeScript. The model
 *      NEVER does the arithmetic. The draft schema deliberately omits
 *      `usageProfile`, so the derived profile is authoritative — there is no
 *      channel for the model to invent sizing numbers.
 *   2. ONE `callStructured` call (reusing `src/lib/prd/llm/client.ts` — we do
 *      NOT open a second Anthropic client) forcing `costRecommendationDraftSchema`.
 *      It gets the PRD context, the roles the PRD needs, and the catalog's REAL
 *      service/SKU ids per role, and is told to pick from that list.
 *   3. 🔴 Every returned `serviceId`/`skuId` is VERIFIED deterministically
 *      against the catalog: it must exist AND fill the role it claims. An
 *      invented or mismatched id is DROPPED and the role falls back to the
 *      catalog default — the same "don't trust, verify" posture as the evidence
 *      gate. A model naming `aws:rds-postgres:xxlarge` cannot produce a broken
 *      selection.
 *   4. Any PRD-required role the model omitted is filled with the catalog
 *      default; choices for roles the PRD does NOT need are dropped.
 *   5. The whole thing is parsed with `costRecommendationSchema` before it is
 *      returned. Failures are `PricingError` (never a raw upstream body).
 *
 * Owned by: backend. Consumes the Feature 1 contract (`CostContext`), the
 * Feature 2 contract (schemas + the pure derivations), and the seam
 * (`RecommendDeployment`, `PricingError`, `DEFAULT_RECOMMEND_MODEL`).
 */

import { GenerationError } from '@/lib/prd/generation';
import { callStructured } from '@/lib/prd/llm/client';
import { z } from 'zod';

import {
  CLOUD_PROVIDERS,
  INFRA_ROLE_LABEL,
  costRecommendationDraftSchema,
  costRecommendationSchema,
  costSelectionSchema,
  type CatalogService,
  type CloudProvider,
  type CostContext,
  type CostRecommendation,
  type CostRecommendationDraft,
  type CostSelection,
  type InfraRole,
  type RoleChoice,
  type ServiceCatalog,
} from '@/types/cost';
import { deriveUsageProfile, mapComponentsToRoles } from '@/lib/cost/estimate/derive';
import {
  PricingError,
  DEFAULT_RECOMMEND_MODEL,
  type RecommendDeployment,
} from '@/lib/cost/pricing-seam';

/* -------------------------------------------------------------------------- */
/* Catalog lookups (pure, built from plain data — no I/O)                     */
/* -------------------------------------------------------------------------- */

/** A service plus the specific SKU chosen for it — the unit of a verified choice. */
interface CatalogPick {
  service: CatalogService;
  skuId: string;
}

/**
 * Index the catalog for the two verification questions this stage asks:
 *   - does this `serviceId` exist, and which role/provider/SKUs does it own?
 *   - does this `skuId` exist, and which service owns it?
 *
 * Built once per call from the (already parse-validated) catalog.
 */
class CatalogIndex {
  private readonly serviceById = new Map<string, CatalogService>();
  private readonly serviceIdBySkuId = new Map<string, string>();
  /** provider → role → services offering that role, in catalog order. */
  private readonly byProviderRole = new Map<string, CatalogService[]>();

  constructor(catalog: ServiceCatalog) {
    for (const service of catalog.services) {
      this.serviceById.set(service.id, service);
      for (const sku of service.skus) {
        this.serviceIdBySkuId.set(sku.id, service.id);
      }
      const key = `${service.provider}|${service.role}`;
      const list = this.byProviderRole.get(key);
      if (list) list.push(service);
      else this.byProviderRole.set(key, [service]);
    }
  }

  getService(serviceId: string): CatalogService | undefined {
    return this.serviceById.get(serviceId);
  }

  /** Which service owns this SKU id, if any. */
  serviceOfSku(skuId: string): CatalogService | undefined {
    const sid = this.serviceIdBySkuId.get(skuId);
    return sid ? this.serviceById.get(sid) : undefined;
  }

  /** Services a provider offers for a role, in catalog order (first = default). */
  servicesFor(provider: CloudProvider, role: InfraRole): CatalogService[] {
    return this.byProviderRole.get(`${provider}|${role}`) ?? [];
  }

  /** Whether a provider can fill a role at all. */
  supports(provider: CloudProvider, role: InfraRole): boolean {
    return this.servicesFor(provider, role).length > 0;
  }

  /**
   * The catalog default for (provider, role): the first service that offers the
   * role and that service's first SKU. `null` when the provider cannot fill the
   * role (e.g. Vercel has no `db-relational`), which becomes an unsupported role
   * rather than a fabricated choice.
   */
  defaultPick(provider: CloudProvider, role: InfraRole): CatalogPick | null {
    const services = this.servicesFor(provider, role);
    const service = services[0];
    if (!service || service.skus.length === 0) return null;
    return { service, skuId: service.skus[0].id };
  }

  /** Every provider that appears in the catalog, in `CLOUD_PROVIDERS` order. */
  providersPresent(): CloudProvider[] {
    const present = new Set<CloudProvider>();
    for (const s of this.serviceById.values()) present.add(s.provider);
    return CLOUD_PROVIDERS.filter((p) => present.has(p));
  }
}

/* -------------------------------------------------------------------------- */
/* Verification: never trust a model-supplied id                              */
/* -------------------------------------------------------------------------- */

/**
 * Verify ONE model-proposed choice for a (provider, role) against the catalog.
 *
 * A choice is accepted ONLY when the SKU exists, its owning service exists, that
 * service belongs to the claimed provider AND fills the claimed role, and the
 * SKU id belongs to that service. Anything else — an invented id, a real id that
 * fills the wrong role, cross-provider leakage — is REJECTED and the caller
 * falls back to the catalog default.
 *
 * Returns the verified pick, or `null` with the reason (for logs/warnings).
 */
function verifyChoice(
  index: CatalogIndex,
  provider: CloudProvider,
  role: InfraRole,
  serviceId: string,
  skuId: string,
): { pick: CatalogPick } | { pick: null; reason: string } {
  const service = index.getService(serviceId);
  if (!service) {
    return { pick: null, reason: `service "${serviceId}" does not exist in the catalog` };
  }
  if (service.provider !== provider) {
    return {
      pick: null,
      reason: `service "${serviceId}" is a ${service.provider} service, not ${provider}`,
    };
  }
  if (service.role !== role) {
    return {
      pick: null,
      reason: `service "${serviceId}" fills role "${service.role}", not "${role}"`,
    };
  }
  const sku = service.skus.find((s) => s.id === skuId);
  if (!sku) {
    return { pick: null, reason: `SKU "${skuId}" does not belong to service "${serviceId}"` };
  }
  return { pick: { service, skuId: sku.id } };
}

/**
 * Build the verified, deduplicated selection for ONE provider.
 *
 * For each PRD-required role the provider CAN fill:
 *   - if the model proposed a choice for that role, verify it; on rejection fall
 *     back to the catalog default;
 *   - if the model omitted the role, fill it with the catalog default.
 * Choices the model volunteered for roles the PRD does NOT need are dropped.
 * Roles the provider cannot fill contribute no choice (they surface later as
 * `unsupportedRoles` in the estimate — a provider is not "cheaper" for lacking a
 * component the app requires).
 *
 * The result satisfies `costSelectionSchema` by construction: one choice per
 * role, every serviceId/skuId provider-consistent and prefix-consistent.
 */
function buildProviderSelection(
  index: CatalogIndex,
  provider: CloudProvider,
  requiredRoles: readonly InfraRole[],
  draftSelection: CostSelection | undefined,
  warnings: string[],
): CostSelection {
  // Index the model's proposed choices by role for this provider (last wins if
  // it duplicated a role — the schema forbids duplicates, but we are defensive).
  const proposed = new Map<InfraRole, RoleChoice>();
  if (draftSelection) {
    for (const choice of draftSelection.choices) {
      proposed.set(choice.role, choice);
    }
  }

  const choices: RoleChoice[] = [];

  for (const role of requiredRoles) {
    if (!index.supports(provider, role)) {
      // The provider genuinely cannot fill this role. No fabricated choice — the
      // engine reports it as an unsupported role from the required-role set.
      continue;
    }

    const modelChoice = proposed.get(role);
    if (modelChoice) {
      const verdict = verifyChoice(
        index,
        provider,
        role,
        modelChoice.serviceId,
        modelChoice.skuId,
      );
      if (verdict.pick) {
        choices.push({
          role,
          serviceId: verdict.pick.service.id,
          skuId: verdict.pick.skuId,
          units: modelChoice.units,
          enabled: modelChoice.enabled,
        });
        continue;
      }
      // Rejected: drop the model's id and fall back to the catalog default.
      warnings.push(
        `Dropped ${provider} choice for role "${role}": ${verdict.reason}. Fell back to the catalog default.`,
      );
    }

    // Either the model omitted this required role, or its choice was rejected.
    const fallback = index.defaultPick(provider, role);
    if (fallback) {
      choices.push({
        role,
        serviceId: fallback.service.id,
        skuId: fallback.skuId,
        units: 1,
        enabled: true,
      });
    }
  }

  // Parse per provider so any residual violation is caught here, attributed to
  // this provider, rather than surfacing as a confusing top-level parse failure.
  const parsed = costSelectionSafeParse(provider, choices);
  return parsed;
}

/** Parse one selection, raising a `PricingError('invalid_output')` on failure. */
function costSelectionSafeParse(provider: CloudProvider, choices: RoleChoice[]): CostSelection {
  const result = costSelectionSchema.safeParse({ provider, choices });
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new PricingError(
      'invalid_output',
      `Built an invalid selection for ${provider} after verification: ${issues}`,
      { provider },
    );
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  'You are a pragmatic cloud infrastructure advisor. Given a product brief and its',
  'architecture, you recommend a deployment provider and a concrete per-provider service',
  'selection. Your output SEEDS an interactive comparison the user can freely change — it',
  'is a well-reasoned starting point, NOT a final verdict.',
  '',
  '## You choose from a fixed menu — you do NOT invent names',
  'For each provider you will be given the EXACT catalog service ids and SKU ids available',
  'for each infrastructure role the app needs. You MUST pick serviceId/skuId values from',
  'that list, copied verbatim. An id you invent, or a service used for the wrong role, will',
  'be DISCARDED by a downstream machine check and silently replaced by the catalog default,',
  'wasting your recommendation. Copy ids exactly; do not paraphrase, guess sizes, or mix a',
  "service from one provider into another provider's selection.",
  '',
  '## Ground the recommendation in THIS brief',
  'Your `rationale` (2–4 sentences) MUST reference the actual brief — the user scale, the',
  'traffic pattern, the budget band, the timeline — not generic best practice. "A startup',
  "budget at 1k–50k MAU with business-hours traffic favours DigitalOcean's flat App Platform",
  'pricing over per-request serverless" is right; "the cloud offers scalability and',
  'flexibility" is wrong and useless.',
  '',
  '## Say what you decided on the user\'s behalf',
  '`assumptions` (at least one) states anything you inferred where the brief was silent —',
  'a sizing choice, an omitted cache, a defaulted database engine. The user must see what',
  'was assumed so they can correct it.',
  '',
  '## Honest trade-offs, pros AND cons',
  'For each provider you seed a selection for, give real `pros` and real `cons` tied to this',
  "app. Missing capabilities are real cons: if a provider cannot run a role the app needs",
  "(e.g. Vercel has no managed Postgres or Kafka), SAY SO plainly in its cons. Do not hide a",
  'gap to make a provider look better.',
  '',
  '## Sizing is NOT your job',
  'Do NOT emit usage numbers, node counts, storage sizes, or traffic figures. Those are',
  'computed deterministically from the brief in TypeScript. Focus only on: which provider,',
  'which service/SKU per role, why, what you assumed, and the trade-offs.',
  '',
  'Respond ONLY by calling the provided tool. Emit `assumptions`, `selections` and',
  '`tradeoffs` as real JSON ARRAYS (e.g. [ ... ]), never as a string containing an array.',
].join('\n');

/**
 * JSON Schema for the forced tool. Deliberately KEPT FLAT and permissive: a
 * deeply-nested schema with `additionalProperties:false` and nested required
 * arrays made sonnet emit array fields as JSON-encoded STRINGS (observed live),
 * so we keep the wire schema simple and rely on the strict Zod re-parse
 * (`costRecommendationDraftSchema`) below for the real contract. Descriptions
 * still carry the "copy ids verbatim" and "pros AND cons" instructions.
 */
const RECOMMEND_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['recommendedProvider', 'rationale', 'assumptions', 'selections', 'tradeoffs'],
  properties: {
    recommendedProvider: { type: 'string', enum: [...CLOUD_PROVIDERS] },
    rationale: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    selections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: [...CLOUD_PROVIDERS] },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                serviceId: { type: 'string' },
                skuId: { type: 'string' },
                units: { type: 'integer' },
                enabled: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    tradeoffs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: [...CLOUD_PROVIDERS] },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

/** Budget for the tool output. A five-provider recommendation with rationale,
 *  assumptions, per-provider selections and trade-offs is a few KB of JSON. */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * The schema handed to `callStructured` is deliberately PERMISSIVE: forced-tool
 * models (observed live with sonnet under a long prompt) intermittently emit an
 * ARRAY field as a JSON-encoded STRING — e.g. `"selections": "[{...}]"` — and
 * `callStructured` would otherwise reject the whole (otherwise-correct) call.
 *
 * So we accept `assumptions`/`selections`/`tradeoffs` as EITHER an array or a
 * string here, do NOT validate their contents at the client, and instead
 * `coerceDraft` (below) decodes any JSON-string arrays, after which the strict
 * `costRecommendationDraftSchema` re-parses for the real contract. This keeps
 * the "don't trust, verify" posture: the strict parse is still the gate, we just
 * fix cosmetic serialisation first rather than discarding good output over it.
 */
const permissiveDraftSchema = z.object({
  recommendedProvider: z.string(),
  rationale: z.string(),
  // Fully permissive on the array fields: the client parse must NEVER reject on
  // shape here (forced-tool models emit these as arrays, JSON-string arrays, or
  // prose strings). `coerceDraft` normalises and then enforces the strict
  // contract, and a coerceDraft failure is a `PricingError` the retry loop can
  // see — a client-side GenerationError would bypass that loop.
  assumptions: z.unknown(),
  selections: z.unknown(),
  tradeoffs: z.unknown(),
});

type PermissiveDraft = z.infer<typeof permissiveDraftSchema>;

/** Decode a field that may be a JSON-encoded array string into a real array. */
function decodeArrayField(val: unknown): unknown {
  if (typeof val !== 'string') return val;
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : val;
  } catch {
    return val;
  }
}

/**
 * Like `decodeArrayField`, but for a STRING-array field (`assumptions`): if the
 * model emitted a single prose string rather than an array — observed reliably
 * with sonnet under a long prompt — wrap it as a one-element array (splitting on
 * newlines/semicolons if it clearly enumerates several). This is not fabrication:
 * it is the model's own text, just re-shaped from a string into the `string[]`
 * the contract asks for. A real JSON-array string is still decoded first.
 */
function decodeStringArrayField(val: unknown): unknown {
  const decoded = decodeArrayField(val);
  if (Array.isArray(decoded)) return decoded;
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    if (trimmed.length === 0) return decoded; // let the strict schema reject empty
    // Prefer newline/semicolon-delimited enumerations; otherwise a single item.
    const parts = trimmed
      .split(/\n+|(?<=[.!?])\s*;\s*/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.length > 0 ? parts : [trimmed];
  }
  return decoded;
}

/**
 * Coerce a permissive draft into the strict `CostRecommendationDraft` shape,
 * decoding any JSON-string arrays first. Throws `PricingError('invalid_output')`
 * if the result still fails the strict schema (a genuinely malformed output, not
 * mere serialisation drift).
 */
function coerceDraft(raw: PermissiveDraft): CostRecommendationDraft {
  const candidate = {
    recommendedProvider: raw.recommendedProvider,
    rationale: raw.rationale,
    assumptions: decodeStringArrayField(raw.assumptions),
    selections: decodeArrayField(raw.selections),
    tradeoffs: decodeArrayField(raw.tradeoffs),
  };
  const parsed = costRecommendationDraftSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new PricingError(
      'invalid_output',
      `Model recommendation failed schema validation: ${issues}`,
    );
  }
  return parsed.data;
}

/**
 * Render the catalog menu the model must choose from: for each provider, and for
 * each role the PRD needs, the available service ids and their SKU ids. This is
 * the fixed vocabulary — the model picks from it, it does not invent names.
 */
function buildCatalogMenu(
  index: CatalogIndex,
  providers: readonly CloudProvider[],
  requiredRoles: readonly InfraRole[],
): string {
  const lines: string[] = [];
  for (const provider of providers) {
    lines.push(`### Provider: ${provider}`);
    for (const role of requiredRoles) {
      const services = index.servicesFor(provider, role);
      if (services.length === 0) {
        lines.push(`- role "${role}" (${INFRA_ROLE_LABEL[role]}): NOT OFFERED by ${provider}`);
        continue;
      }
      lines.push(`- role "${role}" (${INFRA_ROLE_LABEL[role]}):`);
      for (const svc of services) {
        const skus = svc.skus.map((s) => `${s.id} [${s.displayName}]`).join(', ');
        lines.push(`    - serviceId "${svc.id}" (${svc.name}, ${svc.kind}) → skuIds: ${skus}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Render the PRD context the model reasons over. */
function buildContextBlock(costContext: CostContext, requiredRoles: readonly InfraRole[]): string {
  const { context } = costContext;
  return [
    '# Product',
    `Title: ${costContext.title}`,
    costContext.summary ? `Summary: ${costContext.summary}` : '',
    '',
    '# Brief context (drives the recommendation — reference these explicitly)',
    `- User scale: ${context.userScale}`,
    `- Traffic pattern: ${context.trafficPattern}`,
    `- Budget band: ${context.budgetBand}`,
    `- Timeline: ${context.timelineWeeks} weeks`,
    context.constraints ? `- Constraints: ${context.constraints}` : '',
    '',
    '# Architecture components',
    ...costContext.components.map(
      (c) => `- ${c.name} (${c.kind}): ${c.responsibility} [tech: ${c.technology}]`,
    ),
    costContext.infrastructure
      ? `\n# Feature 1 infrastructure reasoning\n${JSON.stringify(costContext.infrastructure, null, 2)}`
      : '',
    '',
    '# Infrastructure roles this app needs (fill each per provider from the menu)',
    ...requiredRoles.map((r) => `- ${r} (${INFRA_ROLE_LABEL[r]})`),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* The stage                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Recommend a provider + per-provider service selection from the PRD context.
 * See the module header for the reason-then-verify contract. Implements the
 * `RecommendDeployment` seam.
 *
 * @throws {PricingError}
 */
export const recommendDeployment: RecommendDeployment = async (
  costContext: CostContext,
  catalog: ServiceCatalog,
  options?: { model?: string; signal?: AbortSignal },
): Promise<CostRecommendation> => {
  // 1. 🔴 TypeScript owns the arithmetic. Derive the usage profile and the
  //    required roles FIRST; the model never sees or supplies sizing numbers.
  const usageProfile = deriveUsageProfile(costContext);
  const { roles: requiredRoles, assumptions: derivedAssumptions } =
    mapComponentsToRoles(costContext);

  const index = new CatalogIndex(catalog);
  const providers = index.providersPresent();
  const model = options?.model ?? DEFAULT_RECOMMEND_MODEL;

  // 2. ONE structured call (with at most ONE bounded retry on serialisation
  //    drift — no loop). Reuse the PRD client — no second Anthropic client. The
  //    permissive schema never rejects on a JSON-string array; `coerceDraft`
  //    decodes those and enforces the STRICT contract. A retry is attempted only
  //    when the first output failed the strict parse (`invalid_output`), which
  //    is the intermittent forced-tool drift, and the retry is hard-capped at 1.
  const userMessage = [
    buildContextBlock(costContext, requiredRoles),
    '',
    '# Catalog menu — pick serviceId/skuId VERBATIM from this list only',
    buildCatalogMenu(index, providers, requiredRoles),
    '',
    'Recommend a provider and seed a selection for each provider that can run this app, now, via the tool.',
    '',
    'CRITICAL OUTPUT FORMAT: `assumptions`, `selections` and `tradeoffs` MUST be real JSON',
    'arrays in the tool call — `assumptions: ["...", "..."]`, `selections: [{...}, {...}]`,',
    '`tradeoffs: [{...}]`. Do NOT put a JSON string in those fields; do NOT concatenate items',
    'into one string. Each must be a genuine array value.',
  ].join('\n');

  /** Hard cap on total attempts (1 initial + up to 2 retries). No unbounded loop. */
  const MAX_ATTEMPTS = 3;

  const callOnce = async (): Promise<CostRecommendationDraft> => {
    const raw = await callStructured<PermissiveDraft>({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      toolName: 'emit_cost_recommendation',
      toolDescription:
        'Emit the deployment recommendation: recommended provider, brief-grounded rationale, assumptions, one seeded selection per runnable provider, and honest per-provider trade-offs.',
      jsonSchema: RECOMMEND_JSON_SCHEMA,
      schema: permissiveDraftSchema,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: options?.signal,
      // `stage` is a fixed PRD-generation union; omit it so `callStructured`
      // labels logs with the toolName instead.
    });
    // Decode any JSON-string arrays, then enforce the strict draft contract.
    return coerceDraft(raw);
  };

  let draft: CostRecommendationDraft;
  try {
    let lastErr: unknown;
    let done = false;
    // Bounded attempts: retry ONLY on strict-parse failure (serialisation drift).
    // not_configured / unavailable / abort are never retried here.
    let attemptDraft: CostRecommendationDraft | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        attemptDraft = await callOnce();
        done = true;
        break;
      } catch (attemptErr) {
        lastErr = attemptErr;
        const retryable =
          attemptErr instanceof PricingError && attemptErr.code === 'invalid_output';
        if (!retryable || options?.signal?.aborted || attempt === MAX_ATTEMPTS - 1) throw attemptErr;
        console.info(
          '[cost.recommend] retrying after invalid_output (serialisation drift), attempt=%d',
          attempt + 1,
        );
      }
    }
    if (!done || !attemptDraft) throw lastErr;
    draft = attemptDraft;
  } catch (err) {
    // A coerceDraft failure is already a PricingError — pass it through.
    if (err instanceof PricingError) throw err;
    // Map the PRD generation error taxonomy onto the pricing one so callers only
    // ever handle `PricingError`. The underlying cause is preserved for logs.
    if (err instanceof GenerationError) {
      const code =
        err.code === 'not_configured'
          ? 'not_configured'
          : err.code === 'invalid_output'
            ? 'invalid_output'
            : 'unavailable';
      throw new PricingError(code, `Cost recommendation failed: ${err.message}`, { cause: err });
    }
    throw new PricingError('unavailable', 'Cost recommendation failed with an unexpected error.', {
      cause: err,
    });
  }

  // 3–4. 🔴 Verify every model-supplied id against the catalog, fill omitted
  //      required roles with the catalog default, drop roles the PRD does not
  //      need, and drop roles the provider cannot fill.
  const warnings: string[] = [];
  const draftByProvider = new Map<CloudProvider, CostSelection>();
  for (const sel of draft.selections) {
    // Keep the last selection a provider was named in (the schema forbids
    // duplicate providers only implicitly; be defensive).
    draftByProvider.set(sel.provider, sel);
  }

  // Seed a selection for EVERY provider present in the catalog, not only the
  // ones the model volunteered — the comparison is more useful with all five,
  // and a provider the model skipped still gets a valid catalog-default seed.
  const selections: CostSelection[] = providers.map((provider) =>
    buildProviderSelection(
      index,
      provider,
      requiredRoles,
      draftByProvider.get(provider),
      warnings,
    ),
  );

  // The recommended provider must be one we actually seeded; if the model named
  // a provider not in the catalog, fall back to the first provider that can fill
  // the most required roles (a sensible default) and record the correction.
  let recommendedProvider = draft.recommendedProvider;
  if (!providers.includes(recommendedProvider)) {
    recommendedProvider = pickFallbackProvider(index, providers, requiredRoles);
    warnings.push(
      `Model recommended "${draft.recommendedProvider}", which is not in the catalog; used "${recommendedProvider}" instead.`,
    );
  }

  // 5. Assemble and parse with the full schema before returning. The derived
  //    assumptions (defaulted datastore, inferred object storage) are merged in
  //    front of the model's, capped to the schema's max of 10.
  const assumptions = dedupeCap([...derivedAssumptions, ...draft.assumptions, ...warnings], 10);

  const recommendation = {
    recommendedProvider,
    rationale: draft.rationale,
    usageProfile,
    assumptions,
    selections,
    tradeoffs: draft.tradeoffs,
  };

  const parsed = costRecommendationSchema.safeParse(recommendation);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new PricingError(
      'invalid_output',
      `Assembled recommendation failed schema validation: ${issues}`,
    );
  }
  return parsed.data;
};

/**
 * When the model names a provider not in the catalog, pick the one that can fill
 * the most required roles (ties broken by `CLOUD_PROVIDERS` order). Deterministic.
 */
function pickFallbackProvider(
  index: CatalogIndex,
  providers: readonly CloudProvider[],
  requiredRoles: readonly InfraRole[],
): CloudProvider {
  let best = providers[0];
  let bestScore = -1;
  for (const provider of providers) {
    const score = requiredRoles.filter((r) => index.supports(provider, r)).length;
    if (score > bestScore) {
      bestScore = score;
      best = provider;
    }
  }
  return best;
}

/** Dedupe (preserving order) and cap a string list to `max` entries. */
function dedupeCap(items: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** Internal helpers exposed for unit tests only. NOT part of the public seam. */
export const _internal = {
  CatalogIndex,
  verifyChoice,
  buildProviderSelection,
  buildCatalogMenu,
  pickFallbackProvider,
  dedupeCap,
};
