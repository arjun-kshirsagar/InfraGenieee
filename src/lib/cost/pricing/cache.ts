/**
 * InfraGenie — the filesystem price-book cache (task B5, docs §6).
 *
 * SERVER-ONLY (uses `node:fs`). Implements `PriceBookCache` from
 * `../pricing-seam`.
 *
 * ## Why a file, not a Map
 *
 * Prices move on a scale of months (`PRICE_MAX_AGE_DAYS = 7`), the payload is
 * small and non-secret, and a file survives dev-server restarts where an
 * in-process `Map` does not — which is exactly what keeps the Tavily/Anthropic
 * quota from being burned on every hot reload. No database, nothing to
 * provision, no cost-safety question (docs §6/§10).
 *
 * Books are stored PER PROVIDER at `.cache/pricing/<provider>.json` (gitignored)
 * so one failing vendor cannot invalidate the other four.
 *
 * ## Miss conditions (a MISS returns null; the caller then rebuilds)
 *
 *   1. the file is absent;
 *   2. it is older than `PRICE_MAX_AGE_DAYS` (by `generatedAt`);
 *   3. it was written by a different `PRICING_PIPELINE_VERSION`;
 *   4. it is not valid JSON, or fails `priceBookSchema`, or is for the wrong
 *      provider.
 *
 * Reads NEVER throw: a corrupt or schema-mismatched file is treated as a miss,
 * so a schema change can never crash the app on a stale file — the same posture
 * as Feature 1's `store.ts`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  priceBookSchema,
  PRICE_MAX_AGE_DAYS,
  PRICING_PIPELINE_VERSION,
  type CloudProvider,
  type PriceBook,
} from '@/types/cost';

import type { PriceBookCache as PriceBookCacheContract } from '../pricing-seam';

/** Default cache root, relative to the process cwd (the repo root at dev/build
 *  time). Computed per-call (not cached at module load). A test injects its own
 *  `rootDir` via the constructor instead of changing the global cwd — mutating
 *  `process.cwd()` would corrupt other test files running in the same worker. */
function defaultCacheDir(): string {
  return path.join(process.cwd(), '.cache', 'pricing');
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** True when `generatedAt` is older than the max age (or unparseable). */
function isStale(generatedAt: string, now: number): boolean {
  const ts = Date.parse(generatedAt);
  if (!Number.isFinite(ts)) return true; // unparseable → treat as stale
  return now - ts > PRICE_MAX_AGE_DAYS * MS_PER_DAY;
}

/**
 * Filesystem cache for price books. Instantiate once and reuse; it holds no
 * state itself (each call hits the disk), so it is safe to share.
 */
export class PriceBookCache implements PriceBookCacheContract {
  /** Injectable clock for tests. Defaults to `Date.now`. */
  private readonly now: () => number;
  /** Injectable cache root for tests. Defaults to `<cwd>/.cache/pricing`. */
  private readonly rootDir: string;

  constructor(options?: { now?: () => number; rootDir?: string }) {
    this.now = options?.now ?? Date.now;
    this.rootDir = options?.rootDir ?? defaultCacheDir();
  }

  private filePath(provider: CloudProvider): string {
    // `provider` is a `CloudProvider` enum value (`aws` | `gcp` | …), so it is a
    // safe filename component — but join defensively via basename anyway so a
    // future non-enum caller cannot path-traverse.
    return path.join(this.rootDir, `${path.basename(provider)}.json`);
  }

  /**
   * Read the cached book for a provider, or `null` on any miss. Never throws.
   */
  async read(provider: CloudProvider): Promise<PriceBook | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(provider), 'utf-8');
    } catch {
      return null; // absent / unreadable → miss
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupt JSON → miss (no crash)
    }

    const result = priceBookSchema.safeParse(parsed);
    if (!result.success) return null; // schema mismatch → miss

    const book = result.data;

    // Guard against a mis-filed book (wrong provider in a provider's file).
    if (book.provider !== provider) return null;
    // Pipeline version bump invalidates every older book.
    if (book.pipelineVersion !== PRICING_PIPELINE_VERSION) return null;
    // Age gate.
    if (isStale(book.generatedAt, this.now())) return null;

    return book;
  }

  /**
   * Write a book to its per-provider file, creating the cache dir if needed.
   * The book is re-validated before writing so a malformed book can never be
   * persisted. Write failures are swallowed (best-effort cache) — a caller must
   * still get its freshly-built book even if the disk is read-only.
   */
  async write(book: PriceBook): Promise<void> {
    const validated = priceBookSchema.safeParse(book);
    if (!validated.success) {
      // Never persist an invalid book; log and no-op (a bad write would poison
      // the next read, which would then be a miss anyway — but this is clearer).
      console.warn(
        '[cost.cache] refusing to write an invalid price book for provider=%s: %s',
        (book as { provider?: string }).provider ?? '?',
        validated.error.issues.map((i) => i.message).join('; '),
      );
      return;
    }

    try {
      await mkdir(this.rootDir, { recursive: true });
      await writeFile(
        this.filePath(validated.data.provider),
        JSON.stringify(validated.data, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.warn(
        '[cost.cache] failed to write price book for provider=%s: %s',
        validated.data.provider,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Shared instance for the build pipeline. */
export const priceBookCache = new PriceBookCache();

export const _internal = { defaultCacheDir, isStale };
