/**
 * Authoring types for the Feature 2 catalog data files (`aws.ts`, `gcp.ts`).
 *
 * The zod schema (`priceDimensionSchema`, `catalogSkuSchema`,
 * `catalogServiceSchema`) declares three fields with `.default(...)`:
 * `PriceDimension.required`, `CatalogSku.defaultUnits` and `CatalogSku.specs`.
 * In the *output* type (`CatalogService`) those are non-optional, so writing a
 * catalog literal against `CatalogService[]` forces you to spell out every
 * default. These authoring types make exactly those defaulted fields optional
 * so the data files stay terse, while `catalogServiceSchema.parse()` in
 * `index.ts` fills the defaults and remains the single source of validation.
 *
 * This is intentionally a hand-written mirror rather than `z.input<...>` so it
 * does not depend on zod's input-inference behaviour, which differs across zod
 * major versions and between `tsc` and `next build`.
 */

import type {
  CatalogService,
  CatalogSku,
  PriceDimension,
} from '@/types/cost';

/** A price dimension as authored — `required` and `pricePerUnits` may be
 *  omitted (they default to `true` and `1` respectively). */
export type PriceDimensionInput = Omit<PriceDimension, 'required' | 'pricePerUnits'> & {
  required?: boolean;
  pricePerUnits?: number;
};

/** A SKU as authored — `specs` and `defaultUnits` may be omitted. */
export type CatalogSkuInput = Omit<CatalogSku, 'specs' | 'defaultUnits' | 'dimensions'> & {
  specs?: CatalogSku['specs'];
  defaultUnits?: number;
  dimensions: PriceDimensionInput[];
};

/** A service as authored — inherits the SKU/dimension defaults above. */
export type CatalogServiceInput = Omit<CatalogService, 'skus'> & {
  skus: CatalogSkuInput[];
};
