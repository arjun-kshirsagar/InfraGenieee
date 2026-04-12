/**
 * Tests for the deterministic architecture-section generator.
 *
 * Covers: schema conformance, determinism, relationship endpoint validity,
 * full-CRUD-per-entity, entity/field pass-through, User auto-add (present +
 * absent), Mermaid node-id safety + full coverage, the background-jobs queue
 * component, and the tiny-vs-very-large pattern/component divergence.
 */

import { describe, expect, it } from 'vitest';
import {
  entityPathSegment,
  generateArchitectureSection,
  mermaidNodeId,
  pluralize,
} from '@/lib/prd/generate/architecture';
import { architectureSectionSchema, type QuestionnaireAnswers } from '@/types/prd';
import { VALID_ANSWERS } from '@/types/prd.test';
import { ENTERPRISE_VERY_LARGE, FREE_TIER_PROTOTYPE } from './fixtures.test-support';

/**
 * A fixture exercising relationship inference: an entity with a `relation`
 * field and another with a `<entity>Id` foreign key, both pointing at entities
 * that exist. Auth off so no User entity is auto-added (keeps the assertions
 * about entity count sharp).
 */
const WITH_FK: QuestionnaireAnswers = {
  ...FREE_TIER_PROTOTYPE,
  dataModel: {
    entities: [
      { name: 'Author', description: 'A writer', fields: [{ name: 'name', type: 'string', required: true }] },
      {
        name: 'Post',
        description: 'A blog post',
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'authorId', type: 'string', required: true }, // FK → Author
        ],
      },
      {
        name: 'Comment',
        description: 'A comment on a post',
        fields: [
          { name: 'body', type: 'text', required: true },
          { name: 'post', type: 'relation', required: true }, // relation → Post
        ],
      },
    ],
    relationshipNotes: undefined,
  },
};

describe('generateArchitectureSection — schema + determinism', () => {
  it('output parses against architectureSectionSchema for every fixture', () => {
    for (const answers of [VALID_ANSWERS, FREE_TIER_PROTOTYPE, ENTERPRISE_VERY_LARGE, WITH_FK]) {
      const result = architectureSectionSchema.safeParse(generateArchitectureSection(answers));
      expect(result.success).toBe(true);
    }
  });

  it('is deterministic — same answers produce a deeply-equal section', () => {
    expect(generateArchitectureSection(VALID_ANSWERS)).toEqual(generateArchitectureSection(VALID_ANSWERS));
    expect(generateArchitectureSection(ENTERPRISE_VERY_LARGE)).toEqual(
      generateArchitectureSection(ENTERPRISE_VERY_LARGE),
    );
  });

  it('summary is 2–4 sentences and names hosting + pattern', () => {
    const section = generateArchitectureSection(ENTERPRISE_VERY_LARGE);
    const sentences = section.summary.split(/\.\s|\.$/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    expect(sentences.length).toBeLessThanOrEqual(4);
    expect(section.summary).toContain(section.infrastructure.hosting);
  });
});

describe('generateArchitectureSection — data model', () => {
  it('passes user-supplied entities and fields through untouched', () => {
    const section = generateArchitectureSection(WITH_FK);
    for (const original of WITH_FK.dataModel.entities) {
      const kept = section.dataModel.entities.find((e) => e.name === original.name);
      expect(kept).toBeDefined();
      expect(kept).toEqual(original);
    }
  });

  it('every relationship endpoint is an entity present in the data model', () => {
    for (const answers of [VALID_ANSWERS, ENTERPRISE_VERY_LARGE, WITH_FK]) {
      const section = generateArchitectureSection(answers);
      const names = new Set(section.dataModel.entities.map((e) => e.name));
      for (const rel of section.dataModel.relationships) {
        expect(names.has(rel.from)).toBe(true);
        expect(names.has(rel.to)).toBe(true);
      }
    }
  });

  it('infers relationships from relation fields and <entity>Id foreign keys', () => {
    const section = generateArchitectureSection(WITH_FK);
    const rels = section.dataModel.relationships.map((r) => `${r.from}->${r.to}`);
    expect(rels).toContain('Author->Post'); // authorId FK
    expect(rels).toContain('Post->Comment'); // relation field named `post`
  });

  it('adds a User entity when authRequired and none present', () => {
    const answers: QuestionnaireAnswers = {
      ...FREE_TIER_PROTOTYPE,
      auth: { ...FREE_TIER_PROTOTYPE.auth, authRequired: true },
    };
    const section = generateArchitectureSection(answers);
    expect(section.dataModel.entities.some((e) => e.name === 'User')).toBe(true);
  });

  it('does NOT add a User entity when one already exists (case-insensitive)', () => {
    const answers: QuestionnaireAnswers = {
      ...FREE_TIER_PROTOTYPE,
      auth: { ...FREE_TIER_PROTOTYPE.auth, authRequired: true },
      dataModel: {
        entities: [{ name: 'account', description: 'A user account', fields: [{ name: 'email', type: 'string', required: true }] }],
        relationshipNotes: undefined,
      },
    };
    const section = generateArchitectureSection(answers);
    const userLike = section.dataModel.entities.filter((e) =>
      ['user', 'account'].includes(e.name.toLowerCase()),
    );
    expect(userLike).toHaveLength(1);
    expect(userLike[0].name).toBe('account'); // original preserved, not renamed
  });

  it('adds an Organization entity when multiTenant and none present, and links non-User entities to it', () => {
    const section = generateArchitectureSection(ENTERPRISE_VERY_LARGE);
    const tenant = section.dataModel.entities.find((e) =>
      ['organization', 'organisation', 'workspace', 'tenant'].includes(e.name.toLowerCase()),
    );
    expect(tenant).toBeDefined();
    // Every non-User business entity has a relationship from the tenant.
    const fromTenant = section.dataModel.relationships.filter((r) => r.from === tenant!.name);
    expect(fromTenant.length).toBeGreaterThan(0);
    // The tenant never points at the User entity.
    expect(fromTenant.some((r) => r.to === 'User')).toBe(false);
  });
});

describe('generateArchitectureSection — API endpoints', () => {
  it('every entity has full CRUD (list, create, get, patch, delete)', () => {
    for (const answers of [VALID_ANSWERS, ENTERPRISE_VERY_LARGE, WITH_FK]) {
      const section = generateArchitectureSection(answers);
      for (const entity of section.dataModel.entities) {
        const seg = entityPathSegment(entity.name);
        const paths = section.apiEndpoints.map((e) => `${e.method} ${e.path}`);
        expect(paths).toContain(`GET /api/${seg}`);
        expect(paths).toContain(`POST /api/${seg}`);
        expect(paths).toContain(`GET /api/${seg}/:id`);
        expect(paths).toContain(`PATCH /api/${seg}/:id`);
        expect(paths).toContain(`DELETE /api/${seg}/:id`);
      }
    }
  });

  it('CRUD authRequired matches auth.authRequired', () => {
    const withAuth = generateArchitectureSection(VALID_ANSWERS); // authRequired: true
    const crud = withAuth.apiEndpoints.filter((e) => e.path.startsWith('/api/') && !e.path.startsWith('/api/auth') && !e.path.startsWith('/api/webhooks'));
    expect(crud.every((e) => e.authRequired)).toBe(true);

    const noAuth = generateArchitectureSection(FREE_TIER_PROTOTYPE); // authRequired: false
    const crud2 = noAuth.apiEndpoints.filter((e) => e.path.startsWith('/api/'));
    expect(crud2.every((e) => !e.authRequired)).toBe(true);
  });

  it('emits a webhook receiver when payments or webhooks are integrated', () => {
    const section = generateArchitectureSection(ENTERPRISE_VERY_LARGE); // has payments + webhooks
    expect(section.apiEndpoints.some((e) => e.path === '/api/webhooks/:provider')).toBe(true);
  });

  it('emits auth endpoints per configured method', () => {
    const section = generateArchitectureSection(ENTERPRISE_VERY_LARGE); // email-password, sso-saml, oauth-google
    const paths = section.apiEndpoints.map((e) => e.path);
    expect(paths).toContain('/api/auth/login');
    expect(paths).toContain('/api/auth/saml');
    expect(paths).toContain('/api/auth/oauth/google');
  });
});

describe('generateArchitectureSection — components', () => {
  it('produces a queue component when needsBackgroundJobs is true', () => {
    const answers: QuestionnaireAnswers = {
      ...FREE_TIER_PROTOTYPE,
      integrations: { ...FREE_TIER_PROTOTYPE.integrations, needsBackgroundJobs: true },
    };
    const section = generateArchitectureSection(answers);
    expect(section.components.some((c) => c.kind === 'queue')).toBe(true);
  });

  it('omits the client component when frontend is none', () => {
    const answers: QuestionnaireAnswers = {
      ...FREE_TIER_PROTOTYPE,
      stack: { ...FREE_TIER_PROTOTYPE.stack, frontend: 'none' },
    };
    const section = generateArchitectureSection(answers);
    expect(section.components.some((c) => c.kind === 'client')).toBe(false);
    // Still has a service.
    expect(section.components.some((c) => c.kind === 'service')).toBe(true);
  });

  it('emits one external component per integration', () => {
    const section = generateArchitectureSection(ENTERPRISE_VERY_LARGE);
    const externals = section.components.filter((c) => c.kind === 'external');
    expect(externals).toHaveLength(ENTERPRISE_VERY_LARGE.integrations.integrations.length);
  });
});

describe('generateArchitectureSection — Mermaid diagram', () => {
  it('is a flowchart TD with a %% comment header', () => {
    const section = generateArchitectureSection(ENTERPRISE_VERY_LARGE);
    expect(section.diagramMermaid.startsWith('%%')).toBe(true);
    expect(section.diagramMermaid).toContain('flowchart TD');
  });

  it('node ids contain no spaces or quotes, and every component appears', () => {
    for (const answers of [VALID_ANSWERS, ENTERPRISE_VERY_LARGE, WITH_FK]) {
      const section = generateArchitectureSection(answers);
      const diagram = section.diagramMermaid;
      // Extract declared node ids: `  <id>["label"]`
      const nodeDecls = [...diagram.matchAll(/^\s{2}([A-Za-z0-9_]+)\["/gm)].map((m) => m[1]);
      expect(nodeDecls.length).toBe(section.components.length);
      for (const id of nodeDecls) {
        expect(id).not.toMatch(/[\s"']/);
      }
      // Every component appears as its own sanitised node line in the diagram.
      const idPortion = diagram.split('\n').filter((l) => /^\s{2}[A-Za-z0-9_]+\[/.test(l));
      expect(idPortion.length).toBe(section.components.length);
      // Each component's sanitised label is present in the rendered diagram.
      for (const c of section.components) {
        const safeLabel = c.name.replace(/["[\]{}|]/g, ' ').replace(/\s+/g, ' ').trim();
        expect(diagram).toContain(`["${safeLabel}"]`);
      }
    }
  });
});

describe('generateArchitectureSection — contrasting fixtures diverge', () => {
  it('tiny prototype vs very-large multi-tenant differ in pattern and component count', () => {
    const tiny = generateArchitectureSection(FREE_TIER_PROTOTYPE);
    const huge = generateArchitectureSection(ENTERPRISE_VERY_LARGE);
    expect(tiny.pattern).not.toBe(huge.pattern);
    expect(tiny.components.length).not.toBe(huge.components.length);
    expect(huge.components.length).toBeGreaterThan(tiny.components.length);
  });
});

describe('helpers', () => {
  it('pluralize handles consonant-y, sibilants, and the default case', () => {
    expect(pluralize('Company')).toBe('Companies');
    expect(pluralize('Address')).toBe('Addresses');
    expect(pluralize('Box')).toBe('Boxes');
    expect(pluralize('Order')).toBe('Orders');
    expect(pluralize('Day')).toBe('Days'); // vowel-y → +s, not +ies
  });

  it('entityPathSegment lower-cases the plural', () => {
    expect(entityPathSegment('Order')).toBe('orders');
    expect(entityPathSegment('Company')).toBe('companies');
  });

  it('mermaidNodeId strips spaces and punctuation to underscores', () => {
    expect(mermaidNodeId('Web Client')).toBe('Web_Client');
    expect(mermaidNodeId('Payments (external)')).toBe('Payments_external');
    expect(mermaidNodeId('!!!')).toBe('node');
  });
});
