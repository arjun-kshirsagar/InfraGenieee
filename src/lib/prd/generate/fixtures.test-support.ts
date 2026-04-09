/**
 * Extra questionnaire fixtures for the generator tests, contrasting with the
 * `VALID_ANSWERS` (medium / startup / postgres) fixture in
 * `src/types/prd.test.ts`. Kept in one place so both infra and prd tests share
 * them and a reviewer can diff the *inputs* that produce different documents.
 */

import type { QuestionnaireAnswers } from '@/types/prd';

/**
 * Bottom of the range: prototype scale, free-tier budget, no hosting/db
 * preference, no auth, no integrations, single tiny entity. Should yield the
 * cheapest managed hosting and the *smallest* legal document.
 */
export const FREE_TIER_PROTOTYPE: QuestionnaireAnswers = {
  basics: {
    projectName: 'Weekend Poller',
    oneLiner: 'A dead-simple one-question poll you share with a link',
    productType: 'web-app',
    targetAudience: 'Friend groups planning something',
    problemStatement: 'Group chats are a terrible place to take a quick vote.',
  },
  scale: {
    userScale: 'prototype',
    peakRequestsPerSecond: 0,
    dataVolumeGb: 0,
    growthExpectation: 'flat',
    regions: ['us-east'],
    uptimeTargetPercent: 99,
  },
  budget: {
    monthlyBudgetBand: 'free-tier',
    budgetIsHardLimit: true,
    teamSize: 1,
    timelineWeeks: 2,
  },
  stack: {
    frontend: 'no-preference',
    backend: 'no-preference',
    database: 'no-preference',
    hosting: 'no-preference',
    mustUse: [],
    mustAvoid: [],
  },
  dataModel: {
    entities: [
      { name: 'Poll', description: 'A single question with options', fields: [{ name: 'question', type: 'string', required: true }] },
    ],
    relationshipNotes: undefined,
  },
  auth: {
    authRequired: false,
    authMethods: [],
    roles: [],
    multiTenant: false,
    compliance: ['none'],
  },
  integrations: {
    integrations: [],
    needsRealtime: false,
    needsBackgroundJobs: false,
    needsFileUploads: false,
    notes: undefined,
  },
};

/**
 * Top of the range: very-large scale, aggressive growth, enterprise budget,
 * no hosting preference (should resolve to cloud-scale), heavy auth with
 * multiple roles + multi-tenant + several compliance flags, many integrations,
 * file uploads, a big team, and several entities. Should yield AWS hosting, a
 * cache, object storage, a staging env, and the *largest* NFR count.
 */
export const ENTERPRISE_VERY_LARGE: QuestionnaireAnswers = {
  basics: {
    projectName: 'GlobalOrders',
    oneLiner: 'Order and fulfilment platform for high-volume retailers',
    productType: 'saas',
    targetAudience: 'Enterprise retail operations teams worldwide',
    problemStatement: 'Large retailers cannot reconcile orders across regions and channels in real time.',
  },
  scale: {
    userScale: 'very-large',
    peakRequestsPerSecond: 5000,
    dataVolumeGb: 40000,
    growthExpectation: 'aggressive',
    regions: ['us-east', 'eu-west', 'ap-southeast'],
    uptimeTargetPercent: 99.99,
  },
  budget: {
    monthlyBudgetBand: 'enterprise',
    budgetIsHardLimit: false,
    teamSize: 25,
    timelineWeeks: 40,
  },
  stack: {
    frontend: 'no-preference',
    backend: 'no-preference',
    database: 'no-preference',
    hosting: 'no-preference',
    mustUse: ['Kafka'],
    mustAvoid: [],
  },
  dataModel: {
    entities: [
      { name: 'Order', description: 'A customer order', fields: [{ name: 'total', type: 'number', required: true }, { name: 'status', type: 'enum', required: true }] },
      { name: 'Product', description: 'A sellable item', fields: [{ name: 'sku', type: 'string', required: true }] },
      { name: 'Warehouse', description: 'A fulfilment location', fields: [{ name: 'region', type: 'string', required: true }] },
      { name: 'Shipment', description: 'An outbound delivery', fields: [{ name: 'carrier', type: 'string', required: true }] },
    ],
    relationshipNotes: 'An Order has many Shipments; a Warehouse fulfils many Orders.',
  },
  auth: {
    authRequired: true,
    authMethods: ['email-password', 'sso-saml', 'oauth-google'],
    roles: ['admin', 'ops-manager', 'warehouse-staff', 'viewer'],
    multiTenant: true,
    compliance: ['gdpr', 'soc2', 'pci'],
  },
  integrations: {
    integrations: ['payments', 'transactional-email', 'file-storage', 'search', 'analytics', 'webhooks'],
    needsRealtime: true,
    needsBackgroundJobs: true,
    needsFileUploads: true,
    notes: 'Must reconcile across regions in near real time.',
  },
};

/**
 * A mustAvoid-collision fixture: no-preference hosting on a very-large,
 * aggressive workload (which would pick AWS), but AWS is explicitly avoided.
 * Used to prove the recommender falls through to the next scale-tier candidate.
 */
export const AVOID_AWS: QuestionnaireAnswers = {
  ...ENTERPRISE_VERY_LARGE,
  stack: { ...ENTERPRISE_VERY_LARGE.stack, mustAvoid: ['AWS', 'DynamoDB'] },
};
