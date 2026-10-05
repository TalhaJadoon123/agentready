/**
 * App Router root layout.
 *
 * Next.js hoists raw <script> tags in App Router, so StructuredData can render
 * directly in the tree — position does not matter much, but keep it in body.
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'AgentReady — SEO for agents. Be found by AI.',
    template: '%s — AgentReady',
  },
  description:
    'Score your website out of 100 for AI readability, generate an MCP server from your catalogue, and register it so assistants can find, quote and buy from you.',
  alternates: { canonical: '/' },
  openGraph: {
    siteName: 'AgentReady',
    type: 'website',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0e14',
};

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const DESCRIPTION =
  'Score your website out of 100 for AI readability, generate an MCP server from your catalogue, and register it so assistants can find, quote and buy from you.';

/**
 * Organization + WebSite + SoftwareApplication + FAQPage JSON-LD.
 *
 * This is the markup AgentReady itself recommends, so we ship it on our own
 * site. An agent reading agentready.dev should be able to answer "what does
 * this product cost" without scraping.
 */
function StructuredData() {
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#organization`,
        name: 'AgentReady',
        url: SITE_URL,
        description: DESCRIPTION,
      },
      { '@type': 'WebSite', '@id': `${SITE_URL}/#website`, name: 'AgentReady', url: SITE_URL },
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#app`,
        name: 'AgentReady',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        description: DESCRIPTION,
        offers: {
          '@type': 'AggregateOffer',
          priceCurrency: 'USD',
          lowPrice: '0.00',
          highPrice: '149.00',
          offerCount: 3,
        },
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/#faq`,
        mainEntity: [
          {
            '@type': 'Question',
            name: 'What does the score actually measure?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'Eight weighted pillars totalling 100: MCP server, structured data, pricing transparency, agent-readable content, transactability, availability signals, machine authentication, and rate limiting.',
            },
          },
          {
            '@type': 'Question',
            name: 'Do I need an API key to try it?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'No. The scanner runs with zero configuration. A free Groq key enables real agent simulation.',
            },
          },
        ],
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      id="agentready:jsonld"
      // JSON.stringify output is escaped so a `</script>` inside data cannot
      // terminate the block early.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/<\//g, '<\\/') }}
    />
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="alternate" type="text/plain" href={`${SITE_URL}/llms.txt`} title="Agent summary" />
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        {children}
        <StructuredData />
      </body>
    </html>
  );
}