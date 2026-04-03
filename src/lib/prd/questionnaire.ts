/**
 * InfraGenie — questionnaire definition for Feature 1.
 *
 * Data-driven form metadata. The frontend renders this array; it must not
 * hardcode fields. Every `path` here MUST resolve against
 * `questionnaireAnswersSchema` in `@/types/prd`.
 *
 * Owned by: architect (cross-cutting contract).
 */

import {
  type QuestionnaireDef,
  type QuestionOption,
} from '@/types/prd';

const opt = (value: string, label: string, hint?: string): QuestionOption => ({ value, label, hint });

export const QUESTIONNAIRE_VERSION = '1.0.0';

export const QUESTIONNAIRE: QuestionnaireDef = {
  version: QUESTIONNAIRE_VERSION,
  steps: [
    {
      key: 'basics',
      title: 'The basics',
      description: 'What are you building, and for whom?',
      questions: [
        { path: 'basics.projectName', label: 'Project name', kind: 'text', required: true, placeholder: 'Acme Invoicing', min: 2, max: 80 },
        { path: 'basics.oneLiner', label: 'One-line pitch', kind: 'text', required: true, placeholder: 'Invoicing that chases late payers for you', help: 'One sentence a stranger would understand.', min: 10, max: 200 },
        {
          path: 'basics.productType', label: 'Product type', kind: 'select', required: true,
          options: [
            opt('web-app', 'Web app', 'User-facing app with a UI'),
            opt('saas', 'SaaS product', 'Subscription, multi-customer'),
            opt('marketplace', 'Marketplace', 'Two-sided supply/demand'),
            opt('api-service', 'API service', 'Programmatic consumers only'),
            opt('internal-tool', 'Internal tool', 'Used inside one company'),
            opt('mobile-backend', 'Mobile backend', 'Serves a native app'),
          ],
        },
        { path: 'basics.targetAudience', label: 'Who is it for?', kind: 'text', required: true, placeholder: 'Freelance designers in the EU', min: 3, max: 200 },
        { path: 'basics.problemStatement', label: 'What problem does it solve?', kind: 'textarea', required: true, help: 'Be concrete — this drives the whole PRD.', min: 10, max: 1000 },
      ],
    },
    {
      key: 'scale',
      title: 'Scale & traffic',
      description: 'How much load should the architecture be designed for?',
      questions: [
        {
          path: 'scale.userScale', label: 'Expected monthly active users', kind: 'select', required: true,
          options: [
            opt('prototype', 'Prototype', 'Under 100 MAU'),
            opt('small', 'Small', '100 – 1,000 MAU'),
            opt('medium', 'Medium', '1,000 – 50,000 MAU'),
            opt('large', 'Large', '50,000 – 500,000 MAU'),
            opt('very-large', 'Very large', 'Over 500,000 MAU'),
          ],
        },
        { path: 'scale.peakRequestsPerSecond', label: 'Peak requests per second', kind: 'number', required: true, min: 0, max: 1000000, help: 'Best guess is fine. 0 if you have no idea.' },
        { path: 'scale.dataVolumeGb', label: 'Stored data after 12 months (GB)', kind: 'number', required: true, min: 0, max: 1000000 },
        {
          path: 'scale.growthExpectation', label: 'Growth expectation', kind: 'select', required: true,
          options: [opt('flat', 'Flat'), opt('steady', 'Steady'), opt('aggressive', 'Aggressive', 'Plan for 10x')],
        },
        {
          path: 'scale.regions', label: 'Regions to serve', kind: 'multi-select', required: true,
          options: [
            opt('us-east', 'US East'), opt('us-west', 'US West'), opt('eu-west', 'EU West'),
            opt('eu-central', 'EU Central'), opt('ap-south', 'Asia Pacific (South)'),
            opt('ap-southeast', 'Asia Pacific (Southeast)'), opt('global-edge', 'Global edge'),
          ],
        },
        { path: 'scale.uptimeTargetPercent', label: 'Uptime target (%)', kind: 'number', required: false, min: 90, max: 99.999, help: 'Default 99.9. Higher targets cost real money.' },
      ],
    },
    {
      key: 'budget',
      title: 'Budget & team',
      description: 'Constraints shape the architecture more than preferences do.',
      questions: [
        {
          path: 'budget.monthlyBudgetBand', label: 'Monthly infrastructure budget', kind: 'select', required: true,
          options: [
            opt('free-tier', 'Free tier only', '$0'),
            opt('hobby', 'Hobby', 'Under $25/mo'),
            opt('startup', 'Startup', '$25 – $250/mo'),
            opt('growth', 'Growth', '$250 – $2,000/mo'),
            opt('enterprise', 'Enterprise', 'Over $2,000/mo'),
          ],
        },
        { path: 'budget.budgetIsHardLimit', label: 'Is that a hard limit?', kind: 'boolean', required: false },
        { path: 'budget.teamSize', label: 'People building it', kind: 'number', required: true, min: 1, max: 500 },
        { path: 'budget.timelineWeeks', label: 'Target timeline (weeks)', kind: 'number', required: true, min: 1, max: 104 },
      ],
    },
    {
      key: 'stack',
      title: 'Stack preferences',
      description: 'Tell us what you already know or must use. "No preference" lets us pick.',
      questions: [
        {
          path: 'stack.frontend', label: 'Frontend', kind: 'select', required: true,
          options: [opt('nextjs', 'Next.js'), opt('react-spa', 'React SPA'), opt('svelte', 'Svelte'), opt('vue', 'Vue'), opt('none', 'No frontend'), opt('no-preference', 'No preference')],
        },
        {
          path: 'stack.backend', label: 'Backend', kind: 'select', required: true,
          options: [opt('next-api-routes', 'Next.js API routes'), opt('node-express', 'Node + Express'), opt('nestjs', 'NestJS'), opt('python-fastapi', 'Python + FastAPI'), opt('go', 'Go'), opt('no-preference', 'No preference')],
        },
        {
          path: 'stack.database', label: 'Database', kind: 'select', required: true,
          options: [opt('postgres', 'PostgreSQL'), opt('mysql', 'MySQL'), opt('mongodb', 'MongoDB'), opt('sqlite', 'SQLite'), opt('dynamodb', 'DynamoDB'), opt('none', 'No database'), opt('no-preference', 'No preference')],
        },
        {
          path: 'stack.hosting', label: 'Preferred hosting', kind: 'select', required: true,
          options: [opt('vercel', 'Vercel'), opt('aws', 'AWS'), opt('render', 'Render'), opt('fly-io', 'Fly.io'), opt('cloudflare', 'Cloudflare'), opt('self-hosted', 'Self-hosted'), opt('no-preference', 'No preference')],
        },
        { path: 'stack.mustUse', label: 'Must use', kind: 'tag-list', required: false, placeholder: 'Stripe, Prisma…', help: 'Press Enter to add.' },
        { path: 'stack.mustAvoid', label: 'Must avoid', kind: 'tag-list', required: false, placeholder: 'Firebase…' },
      ],
    },
    {
      key: 'dataModel',
      title: 'Data model',
      description: 'The core things your product stores. 2–6 entities is typical to start.',
      questions: [
        { path: 'dataModel.entities', label: 'Entities', kind: 'entity-builder', required: true, help: 'Add an entity, then its fields. At least one entity is required.' },
        { path: 'dataModel.relationshipNotes', label: 'Relationship notes', kind: 'textarea', required: false, placeholder: 'A User has many Invoices; an Invoice has many LineItems', max: 1000 },
      ],
    },
    {
      key: 'auth',
      title: 'Auth & compliance',
      description: 'Who gets in, and what rules apply to their data.',
      questions: [
        { path: 'auth.authRequired', label: 'Do users need accounts?', kind: 'boolean', required: true },
        {
          path: 'auth.authMethods', label: 'Sign-in methods', kind: 'multi-select', required: false,
          visibleWhen: { path: 'auth.authRequired', equals: true },
          options: [
            opt('email-password', 'Email + password'), opt('magic-link', 'Magic link'),
            opt('oauth-google', 'Google OAuth'), opt('oauth-github', 'GitHub OAuth'),
            opt('sso-saml', 'Enterprise SSO (SAML)'), opt('api-keys', 'API keys'),
          ],
        },
        { path: 'auth.roles', label: 'User roles', kind: 'tag-list', required: false, placeholder: 'admin, member, viewer', visibleWhen: { path: 'auth.authRequired', equals: true } },
        { path: 'auth.multiTenant', label: 'Multi-tenant (organisations/workspaces)?', kind: 'boolean', required: false, visibleWhen: { path: 'auth.authRequired', equals: true } },
        {
          path: 'auth.compliance', label: 'Compliance requirements', kind: 'multi-select', required: false,
          options: [opt('none', 'None'), opt('gdpr', 'GDPR'), opt('soc2', 'SOC 2'), opt('hipaa', 'HIPAA'), opt('pci', 'PCI-DSS')],
        },
      ],
    },
    {
      key: 'integrations',
      title: 'Integrations & workloads',
      description: 'Third parties and background work drive infrastructure choices.',
      questions: [
        {
          path: 'integrations.integrations', label: 'Integrations needed', kind: 'multi-select', required: false,
          options: [
            opt('payments', 'Payments'), opt('transactional-email', 'Transactional email'),
            opt('file-storage', 'File storage'), opt('search', 'Search'),
            opt('analytics', 'Analytics'), opt('llm-api', 'LLM / AI API'),
            opt('webhooks', 'Outbound webhooks'), opt('maps', 'Maps / geo'), opt('sms', 'SMS'),
          ],
        },
        { path: 'integrations.needsRealtime', label: 'Realtime updates (websockets/live)?', kind: 'boolean', required: false },
        { path: 'integrations.needsBackgroundJobs', label: 'Background jobs / scheduled work?', kind: 'boolean', required: false },
        { path: 'integrations.needsFileUploads', label: 'User file uploads?', kind: 'boolean', required: false },
        { path: 'integrations.notes', label: 'Anything else we should know?', kind: 'textarea', required: false, max: 1000 },
      ],
    },
  ],
};

/** Flat lookup of every question by its answers path. */
export const QUESTIONS_BY_PATH = Object.fromEntries(
  QUESTIONNAIRE.steps.flatMap((step) => step.questions.map((q) => [q.path, q] as const)),
);
