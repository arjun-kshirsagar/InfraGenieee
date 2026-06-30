/**
 * InfraGenie — deterministic model-output normalizers (repair layer).
 *
 * PURE, SERVER-and-client-safe (no imports beyond the schema's enum values).
 *
 * These functions map common natural-language phrasings the model emits into
 * the EXACT zod enum values our schemas require, BEFORE validation runs. They
 * are a safety net, not a loosening of the schema: the enum stays strict
 * (one-to-one | one-to-many | many-to-many); we only translate synonyms the
 * model reaches for despite the tool schema declaring the enum.
 *
 * WHY: live generations (real Anthropic calls) intermittently return
 * relationship `kind` values like "belongs-to", "has-many", "references", or
 * "1:N" instead of the canonical enum. Because our mocked unit tests always
 * used valid enum values, this passed CI green but failed ~half of real runs on
 * the architecture stage — wasting a paid call. See task t_ad18b485 and
 * docs/qa-feature-1.md.
 *
 * DESIGN RULES:
 *   - Never fabricate: if a value is already valid or is unmappable, leave it
 *     untouched (an unmappable value still fails zod, which triggers the ONE
 *     re-ask in runStage rather than a silent wrong guess).
 *   - Deterministic and bounded: a lookup table + light string canonicalization,
 *     no model call, no loop.
 *   - Direction-aware where it matters: a foreign-key "belongs-to"/"references"
 *     (many rows point at one parent) canonicalizes to one-to-many, which is how
 *     our undirected enum expresses a parent↔children edge. "has-one" is a true
 *     one-to-one; "has-many" is one-to-many; "m2m" is many-to-many.
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Schema-driven length clamp — kills the "overflowed .max() cap" bug class    */
/* -------------------------------------------------------------------------- */

/**
 * WHY THIS EXISTS
 *
 * Several free-text fields the MODEL writes are capped with `.max()` in the PRD
 * schema (`field.notes` max 200, `clarifyQuestion.why` max 200, `suggestions`
 * items max 120, entity `description` max 300, …). When a live generation is
 * verbose enough to overflow ANY one of those caps, `schema.safeParse` rejects
 * the ENTIRE multi-stage document and a paid generation is discarded — e.g.
 *   dataModel.entities.5.fields.2.notes: Too big: expected string <=200 chars
 * This is the same CLASS of bug as the relationship-enum drift above: the model
 * emits substance we want, in a shape one hair outside the schema, and throwing
 * the whole (paid) result away is the wrong trade. A note truncated by a few
 * words is fine; losing the generation is not.
 *
 * THE FIX (schema-driven, not one-field)
 *
 * We derive the JSON Schema from the SAME zod schema the stage validates
 * against (`z.toJSONSchema`, exactly as `toInputSchema` already does), which
 * surfaces every string cap as a `maxLength`. We then walk that JSON Schema
 * alongside the raw model output and truncate any over-long string to its cap
 * (trimming on a word boundary and appending an ellipsis when there's room).
 * Because it reads the caps out of the schema itself, EVERY capped free-text
 * field — present and future, across prd/architecture/plan — is covered
 * automatically; no per-field list to keep in sync. See task t_fd71a759.
 *
 * DESIGN RULES (same spirit as the enum repair):
 *   - Deterministic, pure, bounded: one JSON-Schema derivation + one structural
 *     walk. No model call, no loop.
 *   - Never mutates the input (structural sharing clone) so the raw output
 *     stays intact for logging.
 *   - Only touches strings that ACTUALLY exceed their cap; a compliant value is
 *     passed through byte-for-byte. Non-length failures (missing fields, bad
 *     enums, under-volume) are untouched and still fail zod → the existing
 *     repair/re-ask path handles them.
 */

/** The ellipsis appended to a truncated string (counts toward the cap). */
const ELLIPSIS = '…';

/**
 * Truncate `value` to at most `max` characters, preferring to cut on a word
 * boundary and appending an ellipsis when the cap leaves room for it. Uses the
 * spread operator for length so multi-code-unit characters (emoji, etc.) are
 * counted and cut as whole code points, never split mid-surrogate.
 */
export function clampString(value: string, max: number): string {
  if (max <= 0) return '';
  const chars = [...value];
  if (chars.length <= max) return value;

  // Reserve one slot for the ellipsis when the cap is big enough to bother.
  const useEllipsis = max >= 2;
  const budget = useEllipsis ? max - 1 : max;

  let truncated = chars.slice(0, budget).join('');
  // Prefer a word boundary: drop back to the last space, but only if that keeps
  // a reasonable amount of text (don't collapse to almost nothing on a long
  // first "word").
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace >= Math.floor(budget * 0.6)) {
    truncated = truncated.slice(0, lastSpace);
  }
  truncated = truncated.replace(/[\s.,;:!?/-]+$/u, '');
  if (truncated.length === 0) {
    // The head was one unbroken long token — hard-cut it instead of emptying.
    truncated = chars.slice(0, budget).join('');
  }

  return useEllipsis ? truncated + ELLIPSIS : truncated;
}

/**
 * A minimal JSON-Schema node shape — only the keywords our zod schemas produce
 * (`z.toJSONSchema` draft-7 output: type/properties/items/anyOf/oneOf/allOf and
 * maxLength). Everything is optional; unknown keywords are ignored.
 */
interface JsonSchemaNode {
  type?: string | string[];
  maxLength?: number;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  // Some drafts express additionalProperties as a schema; we honour it for maps.
  additionalProperties?: boolean | JsonSchemaNode;
}

/**
 * From a set of schema alternatives (anyOf/oneOf/allOf branches), pick the
 * tightest `maxLength` that applies to a string value. A nullable string is
 * `anyOf: [{type:string, maxLength}, {type:null}]`; we want the string branch's
 * cap. Returns the smallest maxLength found among string-typed branches, or
 * undefined if none constrain length.
 */
function stringMaxFromBranches(branches: JsonSchemaNode[]): number | undefined {
  let best: number | undefined;
  for (const b of branches) {
    const m = stringMaxOf(b);
    if (m != null && (best == null || m < best)) best = m;
  }
  return best;
}

/** The applicable string maxLength for a node, looking through union branches. */
function stringMaxOf(node: JsonSchemaNode): number | undefined {
  if (typeof node.maxLength === 'number') return node.maxLength;
  const branchSets = [node.anyOf, node.oneOf, node.allOf].filter(Boolean) as JsonSchemaNode[][];
  for (const set of branchSets) {
    const m = stringMaxFromBranches(set);
    if (m != null) return m;
  }
  return undefined;
}

/**
 * Recursively clamp every over-long string in `value` to the `maxLength` its
 * position in `node` (a JSON Schema) declares. Structural-sharing clone: only
 * containers on a path that actually changed are copied; unchanged subtrees are
 * returned by reference. Returns `value` itself when nothing changed.
 */
function clampToNode(value: unknown, node: JsonSchemaNode | undefined): unknown {
  if (node == null) return value;

  // Union / intersection: recurse into the first branch that structurally
  // matches the value's kind. For a nullable string this resolves to the string
  // branch; for a discriminated object union, to the matching object shape.
  const branchSets = [node.anyOf, node.oneOf, node.allOf].filter(Boolean) as JsonSchemaNode[][];
  if (branchSets.length > 0 && node.properties == null && node.items == null) {
    for (const set of branchSets) {
      for (const branch of set) {
        if (branchMatchesKind(branch, value)) {
          return clampToNode(value, branch);
        }
      }
    }
    // Fall through — maybe it's a bare string cap expressed via branches.
  }

  if (typeof value === 'string') {
    const max = stringMaxOf(node);
    if (max != null && [...value].length > max) return clampString(value, max);
    return value;
  }

  if (Array.isArray(value)) {
    const itemNode = Array.isArray(node.items) ? node.items[0] : node.items;
    if (itemNode == null) return value;
    let changed = false;
    const next = value.map((el) => {
      const c = clampToNode(el, itemNode);
      if (c !== el) changed = true;
      return c;
    });
    return changed ? next : value;
  }

  if (value != null && typeof value === 'object') {
    const props = node.properties;
    const addl =
      node.additionalProperties && typeof node.additionalProperties === 'object'
        ? (node.additionalProperties as JsonSchemaNode)
        : undefined;
    if (props == null && addl == null) return value;
    const obj = value as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const childNode = props?.[key] ?? addl;
      const c = clampToNode(obj[key], childNode);
      if (c !== obj[key]) changed = true;
      next[key] = c;
    }
    return changed ? next : value;
  }

  return value;
}

/** Does a JSON-Schema branch structurally match the runtime value's kind? */
function branchMatchesKind(branch: JsonSchemaNode, value: unknown): boolean {
  const t = branch.type;
  const types = Array.isArray(t) ? t : t ? [t] : [];
  const kind =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : typeof value === 'object'
          ? 'object'
          : typeof value === 'string'
            ? 'string'
            : typeof value === 'number'
              ? 'number'
              : typeof value === 'boolean'
                ? 'boolean'
                : 'unknown';
  if (types.length > 0) return types.includes(kind);
  // No explicit type on the branch: infer from its structural keywords.
  if (branch.properties || branch.additionalProperties) return kind === 'object';
  if (branch.items) return kind === 'array';
  return true;
}

// Memoize the derived JSON Schema per zod schema — deriving it is not free and
// the same stage schema is reused across every generation.
const jsonSchemaCache = new WeakMap<z.ZodType, JsonSchemaNode>();

function jsonSchemaFor(schema: z.ZodType): JsonSchemaNode {
  const cached = jsonSchemaCache.get(schema);
  if (cached) return cached;
  const derived = z.toJSONSchema(schema, {
    target: 'draft-7',
  } as Parameters<typeof z.toJSONSchema>[1]) as JsonSchemaNode;
  jsonSchemaCache.set(schema, derived);
  return derived;
}

/**
 * Clamp every model-generated free-text string in `raw` to the `.max()` cap its
 * position in `schema` declares, BEFORE `schema.safeParse` runs. Schema-driven,
 * so new capped fields are covered automatically. Pure; returns `raw` unchanged
 * when nothing overflowed (so the enum repair and everything else see identical
 * input in the common case).
 *
 * Defensive: if deriving the JSON Schema ever throws (an exotic schema shape),
 * we return `raw` untouched rather than break generation — clamping is a
 * best-effort salvage layer, never a hard dependency.
 */
export function clampStringsToSchema<T extends z.ZodType>(schema: T, raw: unknown): unknown {
  let node: JsonSchemaNode;
  try {
    node = jsonSchemaFor(schema);
  } catch {
    return raw;
  }
  return clampToNode(raw, node);
}

/** The three canonical relationship-kind enum values (must match the zod enum). */
export const RELATIONSHIP_KINDS = ['one-to-one', 'one-to-many', 'many-to-many'] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

const RELATIONSHIP_KIND_SET: ReadonlySet<string> = new Set(RELATIONSHIP_KINDS);

/**
 * Canonicalize a raw relationship-kind string for lookup: lowercase, trim, and
 * collapse any run of spaces / underscores / hyphens / colons to a single
 * hyphen. So "One To Many", "one_to_many", "1 : N", "has  many" all reduce to a
 * stable key we can match. Digits are kept ("1", "n", "m") for the numeric
 * shorthands.
 */
function canonicalizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_:./]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Synonym → enum table. Keys are ALREADY canonicalized (see canonicalizeKey).
 * Grouped by target for readability. Only add mappings we're confident about;
 * an ambiguous phrase is better left to fail-and-re-ask than mapped wrongly.
 */
const SYNONYM_TO_KIND: Readonly<Record<string, RelationshipKind>> = {
  // --- one-to-one ------------------------------------------------------------
  'one-to-one': 'one-to-one',
  'onetoone': 'one-to-one',
  'has-one': 'one-to-one',
  'hasone': 'one-to-one',
  '1-1': 'one-to-one',
  '1-to-1': 'one-to-one',
  'o2o': 'one-to-one',

  // --- one-to-many -----------------------------------------------------------
  'one-to-many': 'one-to-many',
  'onetomany': 'one-to-many',
  'has-many': 'one-to-many',
  'hasmany': 'one-to-many',
  'have-many': 'one-to-many',
  'one-has-many': 'one-to-many',
  '1-n': 'one-to-many',
  '1-to-n': 'one-to-many',
  '1-m': 'one-to-many',
  '1-to-m': 'one-to-many',
  'o2m': 'one-to-many',
  // Foreign-key "child points at one parent": from the parent's side this edge
  // is one-to-many, which is how our undirected enum expresses it.
  'belongs-to': 'one-to-many',
  'belongsto': 'one-to-many',
  'references': 'one-to-many',
  'reference': 'one-to-many',
  'refers-to': 'one-to-many',
  'foreign-key': 'one-to-many',
  'fk': 'one-to-many',
  'many-to-one': 'one-to-many',
  'manytoone': 'one-to-many',
  'n-1': 'one-to-many',
  'n-to-1': 'one-to-many',
  'm2o': 'one-to-many',

  // --- many-to-many ----------------------------------------------------------
  'many-to-many': 'many-to-many',
  'manytomany': 'many-to-many',
  'm-n': 'many-to-many',
  'm-to-n': 'many-to-many',
  'n-m': 'many-to-many',
  'n-n': 'many-to-many',
  'm-m': 'many-to-many',
  'm2m': 'many-to-many',
};

/**
 * Map one raw relationship-kind value to the canonical enum, or return null if
 * we can't confidently map it (so the caller lets zod reject it and re-ask).
 *
 * An already-valid enum value passes straight through.
 */
export function normalizeRelationshipKind(raw: unknown): RelationshipKind | null {
  if (typeof raw !== 'string') return null;
  if (RELATIONSHIP_KIND_SET.has(raw)) return raw as RelationshipKind;
  const key = canonicalizeKey(raw);
  if (RELATIONSHIP_KIND_SET.has(key)) return key as RelationshipKind;
  return SYNONYM_TO_KIND[key] ?? null;
}

/**
 * Repair hook for the architecture stage: walk `dataModel.relationships[].kind`
 * and rewrite any recognizable synonym to its canonical enum value, leaving
 * everything else structurally identical. Returns a shallow-cloned copy — never
 * mutates the input (the raw model output stays intact for logging).
 *
 * Unknown / unmappable kinds are left as-is on purpose: they must still fail
 * zod so runStage's single re-ask fires, rather than us guessing.
 */
export function repairArchitectureRelationshipKinds(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw;
  const root = raw as Record<string, unknown>;
  const dataModel = root.dataModel;
  if (dataModel == null || typeof dataModel !== 'object') return raw;
  const relationships = (dataModel as Record<string, unknown>).relationships;
  if (!Array.isArray(relationships)) return raw;

  let changed = false;
  const nextRelationships = relationships.map((rel) => {
    if (rel == null || typeof rel !== 'object') return rel;
    const r = rel as Record<string, unknown>;
    const mapped = normalizeRelationshipKind(r.kind);
    // Only rewrite when we produced a DIFFERENT valid value; an already-valid
    // value or an unmappable one is passed through unchanged.
    if (mapped != null && mapped !== r.kind) {
      changed = true;
      return { ...r, kind: mapped };
    }
    return rel;
  });

  if (!changed) return raw;
  return {
    ...root,
    dataModel: { ...(dataModel as Record<string, unknown>), relationships: nextRelationships },
  };
}
