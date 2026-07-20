// @vitest-environment jsdom

/**
 * F3-F3 result components — contract tests.
 *
 * These assert the things that make the deploy payoff trustworthy and safe:
 *   - it renders across every DeployPlan shape from schema-valid fixtures;
 *   - **every** deploy button is `target="_blank" rel="noopener noreferrer"`;
 *   - the `href` is EXACTLY `fit.deployUrl` — the component never rebuilds a URL;
 *   - fits render in the order they arrive (no re-sort);
 *   - a `requiresConfig` fit renders its warning BEFORE the button in DOM order;
 *   - copy copies the exact `content`; download produces a file named exactly
 *     `artifact.filename`;
 *   - the primary card is crowned, and `primary: null` crowns nothing;
 *   - nothing performs a network request to a provider.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { deployPlanSchema } from '@/types/deploy';
import { ProviderFitCard, ProviderFitList } from './provider-fit-card';
import {
  ConfigSnippet,
  copyToClipboard,
  downloadArtifact,
} from './config-snippet';
import { DeployResult } from './deploy-result';
import {
  ALL_DEPLOY_PLANS,
  DJANGO_PLAN,
  DOCKER_PLAN,
  HUGO_PLAN,
  NEXTJS_PLAN,
  RENDER_YAML,
  UNKNOWN_PLAN,
} from './deploy-result.fixtures';

afterEach(cleanup);

/* -------------------------------------------------------------------------- */
/* Fixtures are contract-valid                                                */
/* -------------------------------------------------------------------------- */

describe('fixtures are contract-valid', () => {
  it.each(ALL_DEPLOY_PLANS)('$name plan passes deployPlanSchema', ({ plan }) => {
    const res = deployPlanSchema.safeParse(plan);
    if (!res.success) {
      // Surface the first issue so a drifting fixture fails legibly.
      throw new Error(JSON.stringify(res.error.issues, null, 2));
    }
    expect(res.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Deploy buttons: security attributes + exact href                          */
/* -------------------------------------------------------------------------- */

describe('every deploy button opens the provider safely', () => {
  it.each(ALL_DEPLOY_PLANS)(
    '$name: each button has target=_blank and rel=noopener noreferrer',
    ({ plan }) => {
      render(<ProviderFitList fits={plan.fits} primary={plan.primary} />);
      for (const fit of plan.fits) {
        const btn = screen.getByTestId(`deploy-button-${fit.provider}`);
        expect(btn).toHaveAttribute('target', '_blank');
        const rel = btn.getAttribute('rel') ?? '';
        expect(rel).toContain('noopener');
        expect(rel).toContain('noreferrer');
      }
    },
  );

  it.each(ALL_DEPLOY_PLANS)(
    '$name: the href is EXACTLY fit.deployUrl (never rebuilt)',
    ({ plan }) => {
      render(<ProviderFitList fits={plan.fits} primary={plan.primary} />);
      for (const fit of plan.fits) {
        const btn = screen.getByTestId(`deploy-button-${fit.provider}`);
        expect(btn).toHaveAttribute('href', fit.deployUrl);
      }
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Order preservation (already score-sorted upstream)                        */
/* -------------------------------------------------------------------------- */

describe('fits render in the order they arrive', () => {
  it('does not re-sort — DOM order matches the fits array', () => {
    render(<ProviderFitList fits={DJANGO_PLAN.fits} primary={DJANGO_PLAN.primary} />);
    const buttons = screen.getAllByTestId(/^deploy-button-/);
    const domOrder = buttons.map((b) => b.getAttribute('data-testid'));
    const expected = DJANGO_PLAN.fits.map((f) => `deploy-button-${f.provider}`);
    expect(domOrder).toEqual(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* Primary crown / null lead-in                                              */
/* -------------------------------------------------------------------------- */

describe('primary treatment', () => {
  it('crowns the primary provider', () => {
    render(<ProviderFitList fits={NEXTJS_PLAN.fits} primary="vercel" />);
    expect(screen.getByText(/best fit for your app/i)).toBeInTheDocument();
  });

  it('crowns nothing and shows a lead-in when primary is null', () => {
    render(<ProviderFitList fits={UNKNOWN_PLAN.fits} primary={null} />);
    expect(screen.queryByText(/best fit for your app/i)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn.t read enough of your repo/i)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* not-recommended still deploys                                             */
/* -------------------------------------------------------------------------- */

describe('not-recommended providers', () => {
  it('still render a clickable deploy button plus the reason it is a bad idea', () => {
    render(<ProviderFitList fits={DOCKER_PLAN.fits} primary={DOCKER_PLAN.primary} />);
    // Vercel is not-recommended here.
    const btn = screen.getByTestId('deploy-button-vercel');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('href', DOCKER_PLAN.fits.find((f) => f.provider === 'vercel')!.deployUrl);
    expect(
      screen.getByText(/does not run arbitrary Docker containers/i),
    ).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* requiresConfig: warning BEFORE the button, in DOM order                   */
/* -------------------------------------------------------------------------- */

describe('requiresConfig fit', () => {
  it('renders its warning before the deploy button in DOM order', () => {
    const renderFit = DJANGO_PLAN.fits.find((f) => f.provider === 'render')!;
    expect(renderFit.requiresConfig).toBe(true);
    render(<ProviderFitCard fit={renderFit} isPrimary />);

    const warning = screen.getByText(/won.t know what to build/i);
    const button = screen.getByTestId('deploy-button-render');

    // DOCUMENT_POSITION_FOLLOWING (4) means `button` comes after `warning`.
    const pos = warning.compareDocumentPosition(button);
    expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('anchors to the matching config snippet', () => {
    const renderFit = DJANGO_PLAN.fits.find((f) => f.provider === 'render')!;
    render(<ProviderFitCard fit={renderFit} isPrimary />);
    const anchor = screen.getByRole('link', { name: /jump to the render\.yaml snippet/i });
    expect(anchor).toHaveAttribute('href', '#config-snippet-render');
  });

  it('does not show the requiresConfig warning when the fit does not need config', () => {
    const vercelFit = NEXTJS_PLAN.fits.find((f) => f.provider === 'vercel')!;
    render(<ProviderFitCard fit={vercelFit} isPrimary />);
    expect(screen.queryByText(/won.t know what to build/i)).not.toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */
/* No network requests to a provider                                         */
/* -------------------------------------------------------------------------- */

describe('never performs a network request', () => {
  it('does not call fetch when rendering fits', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    render(<DeployResult plan={DJANGO_PLAN} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/* -------------------------------------------------------------------------- */
/* Config snippet: copy + download handlers                                  */
/* -------------------------------------------------------------------------- */

describe('copyToClipboard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies the exact content via navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ok = await copyToClipboard(RENDER_YAML.content);
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(RENDER_YAML.content);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('falls back to execCommand when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {}); // no clipboard
    const execCommand = vi.fn().mockReturnValue(true);
    // jsdom lacks execCommand; attach a spy.
    (document as unknown as { execCommand: unknown }).execCommand = execCommand;
    const ok = await copyToClipboard('hello');
    expect(ok).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
  });
});

describe('downloadArtifact', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clickSpy: ReturnType<typeof vi.fn>;
  let capturedDownload: string | null;
  let capturedHref: string | null;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;

    capturedDownload = null;
    capturedHref = null;
    clickSpy = vi.fn(function (this: HTMLAnchorElement) {
      capturedDownload = this.getAttribute('download');
      capturedHref = this.getAttribute('href');
    });
    // Intercept the transient anchor's click.
    HTMLAnchorElement.prototype.click = clickSpy as unknown as () => void;
  });

  it('produces a file named exactly artifact.filename and revokes the URL', () => {
    downloadArtifact(RENDER_YAML.filename, RENDER_YAML.content, 'text/yaml');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // The Blob carries the exact content.
    const blobArg = createObjectURL.mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(capturedDownload).toBe(RENDER_YAML.filename);
    expect(capturedHref).toBe('blob:mock-url');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});

/* -------------------------------------------------------------------------- */
/* Config snippet: rendering                                                 */
/* -------------------------------------------------------------------------- */

describe('<ConfigSnippet>', () => {
  it('renders filename, why, content, and the anchor id for the provider', () => {
    const { container } = render(<ConfigSnippet artifact={RENDER_YAML} />);
    expect(screen.getByText('render.yaml')).toBeInTheDocument();
    expect(screen.getByText(RENDER_YAML.why)).toBeInTheDocument();
    // content appears verbatim inside the pre block
    expect(container.querySelector('pre')?.textContent).toContain('autoDeploy: false');
    // anchor target for the requiresConfig jump-link
    expect(container.querySelector('#config-snippet-render')).toBeInTheDocument();
  });

  it('marks required artifacts as Required and optional as Optional', () => {
    render(<ConfigSnippet artifact={RENDER_YAML} />);
    expect(screen.getByText('Required')).toBeInTheDocument();

    cleanup();
    render(
      <ConfigSnippet
        artifact={{
          ...RENDER_YAML,
          required: false,
          filename: 'vercel.json',
          provider: 'vercel',
          language: 'json',
          content: '{ "framework": "nextjs" }',
        }}
      />,
    );
    expect(screen.getByText('Optional')).toBeInTheDocument();
  });

  it('clicking Copy copies the exact content', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    // Define clipboard AFTER userEvent.setup() so our spy is the one invoked
    // (userEvent installs its own clipboard stub on setup()).
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<ConfigSnippet artifact={RENDER_YAML} />);
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith(RENDER_YAML.content);
  });
});

/* -------------------------------------------------------------------------- */
/* Full composer renders every shape                                         */
/* -------------------------------------------------------------------------- */

describe('<DeployResult> renders every shape', () => {
  it.each(ALL_DEPLOY_PLANS)('renders the $name plan without throwing', ({ plan }) => {
    render(<DeployResult plan={plan} />);
    // three deploy buttons always present
    expect(screen.getAllByTestId(/^deploy-button-/)).toHaveLength(3);
  });

  it('renders the assumptions block when present', () => {
    render(<DeployResult plan={DJANGO_PLAN} />);
    expect(screen.getByText(/what we assumed/i)).toBeInTheDocument();
    expect(screen.getByText(/single web service plus one Postgres/i)).toBeInTheDocument();
  });

  it('renders config snippets only when the plan has them', () => {
    const { container, rerender } = render(<DeployResult plan={DJANGO_PLAN} />);
    // The snippet card is uniquely identified by its anchor id.
    expect(container.querySelector('#config-snippet-render')).toBeInTheDocument();
    rerender(<DeployResult plan={HUGO_PLAN} />);
    expect(container.querySelector('#config-snippet-render')).not.toBeInTheDocument();
  });
});
