/**
 * Snippet injection.
 *
 * We never write to a customer's site. We hand them a snippet and, where the
 * platform allows it, a snippet that is safe to paste into an existing block
 * without breaking the page.
 *
 * The one transformation we do perform is `injectIntoHtml`, which is
 * idempotent: injecting twice produces one script block, not two. That property
 * matters because most people paste snippets into a header field and then also
 * edit the theme file.
 */

import { toScriptTag } from './generate.js';
import { serverSlug } from '@agentready/shared';

export type Platform = 'wordpress' | 'shopify' | 'next' | 'custom' | 'html';

export interface InjectionPlan {
  platform: Platform;
  /** Where the snippet must go. */
  location: string;
  snippet: string;
  /** Human instructions for a non-developer. */
  instructions: string[];
  /** Platform-specific warnings. */
  warnings: string[];
}

export const MARKER = 'agentready:jsonld';

/**
 * Wrap a document in a script tag with a stable id so we can detect and skip
 * re-injection.
 */
export function snippetFor(document: Record<string, unknown>, id = MARKER): string {
  return toScriptTag(document, { id });
}

/**
 * Inject JSON-LD into an HTML document, idempotently.
 * Prefers `<head>`; falls back to prepending when there is no head.
 */
export function injectIntoHtml(html: string, document: Record<string, unknown>, id = MARKER): string {
  const script = snippetFor(document, id);

  // Already present — replace it rather than duplicating.
  if (html.includes(`id="${id}"`)) {
    const re = new RegExp(`<script[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/script>\\s*`, 'i');
    return html.replace(re, script);
  }

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, (m) => `${m}\n${script}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html([^>]*)\s*>/i, (m) => `${m}\n<head>\n${script}\n</head>`);
  }
  if (/<body[^>]*>/i.test(html)) {
    // A body with no head: give it one, so the markup lands where it belongs.
    return html.replace(/<body([^>]*)>/i, (m) => `<head>\n${script}\n</head>\n${m}`);
  }
  return `${script}\n${html}`;
}

/** WordPress: a functions.php snippet or the Yoast/RankMath field. */
export function injectWordPress(document: Record<string, unknown>, themeSlug = 'theme'): InjectionPlan {
  const script = snippetFor(document);
  const slug = serverSlug(themeSlug) || 'theme';

  const php = `/**
 * AgentReady — schema.org JSON-LD
 *
 * Preferred: paste this into Appearance > Theme Editor > functions.php, or use
 * a snippet plugin (WPCode, Snippets) with the "Run everywhere" type.
 * Remove the ${MARKER} block if you ever want to disable it.
 */
add_action('wp_head', function () {
  if (defined('AGENTREADY_LD')) {
    echo wp_json_encode(AGENTREADY_LD, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  }
}, 1);

// Or, without touching PHP, drop the raw block in your SEO plugin's
// "Schema / Custom Code" field:
${script}
`;

  return {
    platform: 'wordpress',
    location: 'wp_head',
    snippet: php,
    instructions: [
      'Easiest route: install the "WPCode" plugin, add a PHP snippet, set Type to "PHP Snippet" and "Insert" to "Everywhere".',
      'Paste the code above and save. Reload your homepage and view source — search for "application/ld+json".',
      'Alternative: in your SEO plugin (Yoast or RankMath) open Settings > Schema and paste the <script> block into the custom field.',
      'If you use a page builder, put the <script> block in a "Custom HTML" element on the homepage template.',
    ],
    warnings: [
      'WordPress strips <?php blocks pasted into Custom HTML fields. Use a snippet plugin or functions.php for the PHP version.',
      `Do not paste this into both functions.php and a snippet plugin — you will end up with two identical ${MARKER} blocks.`,
      `If you use a child theme, ${slug}.php overrides are safe; edits to the parent theme will be lost on update.`,
    ],
  };
}

/** Shopify: `theme.liquid` layout, or the app block. */
export function injectShopify(document: Record<string, unknown>, siteUrl = 'https://your-store.myshopify.com'): InjectionPlan {
  const org = (document as { '@graph'?: Array<Record<string, unknown>> })['@graph']?.find(
    (n) => String(n['@type'] ?? '') === 'Organization',
  );

  const liquid = `{%- comment -%} AgentReady schema.org JSON-LD {%- endcomment -%}
<script type="application/ld+json">
${JSON.stringify({ ...document, url: siteUrl })}
</script>
`;

  const sectionsSnippet = `{%- comment -%}
  Add this to your main sections/*.liquid or layout/theme.liquid,
  inside <head>. Shopify renders {% raw %}{{ }}{% endraw %} in these files.
{%- endcomment -%}
${liquid}
${org ? `\n<!-- Organization @id: ${String(org['@id'] ?? '')} -->` : ''}
`;

  return {
    platform: 'shopify',
    location: 'layout/theme.liquid <head>',
    snippet: sectionsSnippet,
    instructions: [
      'Shopify Admin > Online Store > Themes > Actions > Edit code.',
      'Open layout/theme.liquid and paste the snippet inside <head>.',
      'Save. Shopify validates Liquid at save time — a red screen means you pasted into the wrong tag.',
      'Verify on your live store: view source and search for "application/ld+json".',
    ],
    warnings: [
      'Do not put this in custom.js or a script tag — Shopify CSP and theme.liquid ordering will strip it.',
      'Product-level JSON-LD should come from your product metafields, not one global block. Generate per-product snippets with `agentready schema --product`.',
    ],
  };
}

/** Next.js / React Server Components. */
export function injectNextJs(document: Record<string, unknown>, siteUrl = 'https://example.com'): InjectionPlan {
  const tsx = `import type { MetadataRoute } from 'next';
import { buildSchemaScript } from '@agentready/schema';

const SITE_URL = '${siteUrl}';

/**
 * Put this in app/layout.tsx. In Next.js App Router you can render a raw
 * <script> in the component tree; Next hoists it to <head> automatically.
 */
export default function StructuredData() {
  const ld = ${JSON.stringify(document, null, 2)};

  return (
    <script
      type="application/ld+json"
      id="${MARKER}"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/<\\//g, '<\\\\/') }}
    />
  );
}

/**
 * Per-product structured data: put this in app/products/[slug]/page.tsx
 * and call it with the product.
 */
export function productStructuredData(product: unknown) {
  return buildSchemaScript({ products: [product as never], siteUrl: SITE_URL });
}

/**
 * Verify the site is registered and serves the AgentReady verification token:
 *   export const dynamic = 'force-static';
 */
export const robots: MetadataRoute.Robots = {
  rules: [{ userAgent: '*', allow: '/' }],
};
`;

  return {
    platform: 'next',
    location: 'app/layout.tsx',
    snippet: tsx,
    instructions: [
      'Paste the StructuredData component into app/layout.tsx and render <StructuredData /> inside your <html><body>.',
      'Next.js hoists raw <script> tags in App Router, so position does not matter much — but keep it inside body.',
      'Build with `npm run build` and check for a hydration warning about the script; if you see one, add suppressHydrationWarning to <html>.',
      'Confirm in production, not dev — dev mode injects the React dev overlay which can mask rendering issues.',
    ],
    warnings: [
      'Do not use next/head in App Router — it is deprecated and will silently drop the tag in some versions.',
      'If you render per-product JSON-LD, make sure it does not duplicate the global block.',
    ],
  };
}

/** Plain HTML / static site: insert into <head> of your template. */
export function injectCustomHtml(document: Record<string, unknown>): InjectionPlan {
  return {
    platform: 'custom',
    location: '</head>',
    snippet: snippetFor(document),
    instructions: [
      'Paste the script block immediately before </head> in your HTML template.',
      'If you have no template (a hand-built site), paste it directly into the <head> of index.html.',
      'Re-upload, then verify: view source, search for "application/ld+json".',
    ],
    warnings: [
      'Make sure you are editing the <head> of the page an agent lands on, not a 404 template.',
      'Some static site generators strip <script> from head. If it disappears, use a "head partial" or the custom template feature.',
    ],
  };
}

/** Dispatch to the right injector. */
export function inject(document: Record<string, unknown>, platform: Platform, options: { siteUrl?: string; themeSlug?: string } = {}): InjectionPlan {
  switch (platform) {
    case 'wordpress':
      return injectWordPress(document, options.themeSlug);
    case 'shopify':
      return injectShopify(document, options.siteUrl);
    case 'next':
      return injectNextJs(document, options.siteUrl);
    case 'custom':
    case 'html':
    default:
      return injectCustomHtml(document);
  }
}

/**
 * llms.txt generation — the emerging convention for telling an agent what a
 * site is and where the detail lives. Cheap to produce, high leverage.
 */
export function generateLlmsTxt(input: {
  name: string;
  url: string;
  description: string;
  sections?: Array<{ title: string; items: string[] }>;
  contact?: string;
}): string {
  const lines: string[] = [`# ${input.name}`, '', `> ${input.description}`, '', `Site: ${input.url}`];

  if (input.contact) lines.push(`Contact: ${input.contact}`);

  for (const section of input.sections ?? []) {
    if (section.items.length === 0) continue;
    lines.push('', `## ${section.title}`);
    for (const item of section.items) lines.push(`- ${item}`);
  }

  lines.push('', '## Optional', '- [Full text](SITE_URL/llms-full.txt)');
  return lines.join('\n');
}