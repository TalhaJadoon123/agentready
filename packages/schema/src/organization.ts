/** Organization / WebSite JSON-LD generation. */

import type { Organization } from '@agentready/shared';
import { organizationNode } from './generate.js';

export { organizationNode as buildOrganization };

/** The Organization node agents use to establish identity. */
export function generateOrganization(org: Organization): Record<string, unknown> {
  return organizationNode(org);
}

/**
 * WebSite node with SearchAction.
 * Declaring a search action tells an agent it can query your site directly
 * instead of guessing at URL patterns.
 */
export function generateWebSite(site: {
  name: string;
  url: string;
  description?: string;
  searchUrlTemplate?: string;
  publisherId?: string;
}): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@type': 'WebSite',
    '@id': `${site.url.replace(/\/$/, '')}/#website`,
    name: site.name,
    url: site.url,
    ...(site.description ? { description: site.description } : {}),
    ...(site.publisherId ? { publisher: { '@id': site.publisherId } } : {}),
  };

  if (site.searchUrlTemplate) {
    node['potentialAction'] = {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: site.searchUrlTemplate,
      },
      'query-input': 'required name=searchTerm',
    };
  }

  return node;
}

/** FAQPage — the format agents quote most often. */
export function generateFaqPage(entries: Array<{ question: string; answer: string }>): Record<string, unknown> {
  return {
    '@type': 'FAQPage',
    mainEntity: entries.map((e) => ({
      '@type': 'Question',
      name: e.question,
      acceptedAnswer: { '@type': 'Answer', text: e.answer },
    })),
  };
}

/** HowTo — for a service that is a sequence of agent-executable steps. */
export function generateHowTo(opts: {
  name: string;
  description: string;
  steps: Array<{ name: string; text: string; url?: string }>;
}): Record<string, unknown> {
  return {
    '@type': 'HowTo',
    name: opts.name,
    description: opts.description,
    step: opts.steps.map((s, i) => ({
      '@type': 'HowToStep',
      position: i + 1,
      name: s.name,
      text: s.text,
      ...(s.url ? { url: s.url } : {}),
    })),
  };
}