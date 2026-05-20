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
