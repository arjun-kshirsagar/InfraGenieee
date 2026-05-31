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
 * Extensibility: to add a provider, write `src/lib/cost/catalog/<provider>.ts`
 * exporting a `CatalogServiceInput[]` and append it to `PROVIDER_SERVICES`
 * below — nothing else changes. (B3 added Azure, Vercel and DigitalOcean this
 * way, completing the five-provider §9 coverage grid.)
 */

import { serviceCatalogSchema, CATALOG_VERSION, type ServiceCatalog } from '@/types/cost';

import { awsServices } from './aws';
import { gcpServices } from './gcp';
import { azureServices } from './azure';
import { vercelServices } from './vercel';
import { digitalOceanServices } from './digitalocean';

/**
 * Every provider slice, in display order. Appending a new provider's
 * `CatalogServiceInput[]` here is the only change needed to add it — the
 * assembly and validation below are provider-agnostic.
 */
const PROVIDER_SERVICES = [
  ...awsServices,
  ...gcpServices,
  ...azureServices,
  ...vercelServices,
  ...digitalOceanServices,
];

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
export { azureServices } from './azure';
export { vercelServices } from './vercel';
export { digitalOceanServices } from './digitalocean';
