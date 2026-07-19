/**
 * InfraGenie — Feature 3, config-artifact aggregator (task B6, docs §7).
 *
 * `generateConfigs(detection, ref)` runs every generator and returns the
 * artifacts that apply — a `render.yaml` when the app needs one, and the
 * `vercel.json` / `netlify.toml` hints only when detection found something the
 * provider won't infer. Generators that have nothing to say return `null`; this
 * function just drops the nulls.
 *
 * Order is stable (render, vercel, netlify) so the output is deterministic — the
 * whole module is pure, like the rest of `src/lib/deploy` except `source/`.
 */

import type { ConfigArtifact, StackDetection, RepoRef } from '@/types/deploy';

import { generateRenderYaml } from './render-yaml';
import { generateVercelJson, generateNetlifyToml } from './vercel-netlify';

export { generateRenderYaml } from './render-yaml';
export { generateVercelJson, generateNetlifyToml } from './vercel-netlify';

export function generateConfigs(detection: StackDetection, ref: RepoRef): ConfigArtifact[] {
  const candidates = [
    generateRenderYaml(detection, ref),
    generateVercelJson(detection, ref),
    generateNetlifyToml(detection, ref),
  ];
  return candidates.filter((c): c is ConfigArtifact => c !== null);
}
