/**
 * Feature 2 service catalog — assembly point.
 *
 * Combines each provider's `CatalogService[]` into one `ServiceCatalog` and
 * validates it against `serviceCatalogSchema` (which enforces id-prefix rules
 * and rejects duplicate service / SKU / dimension ids — a typo fails loudly
 * here rather than surfacing as a mysteriously unpriced line item in the UI).
 *
 * STRUCTURE ONLY — NO PRICES. Numbers arrive exclusively as fetched, cited
 * `PriceRecord`s through the pricing layer's evidence gate.
 *
 * Extensibility: B3 adds Azure, Vercel and DigitalOcean. To add a provider,
 * write `src/lib/cost/catalog/<provider>.ts` exporting a `CatalogServiceInput[]`
 * and append it to `PROVIDER_SERVICES` below — nothing else changes.
 */

import { serviceCatalogSchema, CATALOG_VERSION, type ServiceCatalog } from '@/types/cost';

import { awsServices } from './aws';
import { gcpServices } from './gcp';

/**
 * Every provider slice, in display order. B3 appends `azureServices`,
 * `vercelServices`, `digitalOceanServices` here — the assembly and validation
 * below need no other change.
 */
const PROVIDER_SERVICES = [...gcpServices, ...awsServices];

/**
 * The assembled, validated catalog. `serviceCatalogSchema.parse` fills the
 * defaulted fields (`required`, `defaultUnits`, `specs`) and throws on any
 * integrity violation, so importing this module is itself a correctness check.
 */
export const serviceCatalog: ServiceCatalog = serviceCatalogSchema.parse({
  version: CATALOG_VERSION,
  services: PROVIDER_SERVICES,
});

/** Convenience: the assembled services array (post-parse, defaults applied). */
export const catalogServices = serviceCatalog.services;

export { awsServices } from './aws';
export { gcpServices } from './gcp';
