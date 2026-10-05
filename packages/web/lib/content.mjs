/**
 * Site content. Kept in one place so the marketing page, the docs and the
 * dashboard cannot drift apart.
 */

export const PILLARS = [
  { pts: 20, title: 'MCP server', desc: 'A live Model Context Protocol server with the five commerce tools. This is what lets an agent act, not just read.' },
  { pts: 20, title: 'Structured data', desc: 'schema.org JSON-LD with Organization, Product, Offer, price, currency and availability — the facts agents read first.' },
  { pts: 14, title: 'Pricing transparency', desc: 'Public prices in both your markup and your page text. Gated pricing removes you from every "how much does X cost" answer.' },
  { pts: 12, title: 'Agent-readable content', desc: 'An /llms.txt summary, real server-rendered prose, and question-shaped headings an assistant can quote.' },
  { pts: 12, title: 'Transactability', desc: 'A documented order path — ideally a place_order MCP tool, so a purchase completes without a human in the loop.' },
  { pts: 10, title: 'Availability signals', desc: 'schema.org availability plus honest stock language, so an agent never promises something you cannot ship.' },
  { pts: 7, title: 'Machine authentication', desc: 'OAuth discovery with the client_credentials grant, so an unattended agent can prove who it is.' },
  { pts: 5, title: 'Rate limiting & docs', desc: 'Documented limits and RateLimit headers, so an agent can budget its calls instead of guessing.' },
];

export const PRICING = [
  {
    name: 'Free',
    price: '$0',
    per: ' forever',
    blurb: 'See your score and your single highest-impact fix.',
    features: ['1 scan per month', 'Full 8-pillar breakdown', 'Copy-paste fixes', 'Agent-readable score (public verify page)'],
    cta: 'Scan my site',
    ctaHref: '/dashboard',
    featured: false,
  },
  {
    name: 'Starter',
    price: '$49',
    per: '/mo',
    blurb: 'For a single store that wants to be buyable by agents.',
    features: [
      '50 scans per month',
      '1 MCP server generated and deployed',
      'CSV, JSON, API and scrape sources',
      'Cloudflare Workers or Smithery deploy',
      'Registry submission (official, Smithery, mcp.so)',
      'Agent traffic & revenue dashboard',
      '5 uptime monitors with email alerts',
    ],
    cta: 'Start Starter',
    ctaHref: '/dashboard?upgrade=starter',
    featured: true,
  },
  {
    name: 'Business',
    price: '$149',
    per: '/mo',
    blurb: 'For teams running agent commerce across several properties.',
    features: [
      '1,000 scans per month',
      '10 MCP servers',
      'Competitive benchmarking vs named rivals',
      'Groq-powered agent simulation',
      '50 monitors & alerting',
      'Priority support',
    ],
    cta: 'Start Business',
    ctaHref: '/dashboard?upgrade=business',
    featured: false,
  },
];

export const FAQ = [
  {
    q: 'What does the score actually measure?',
    a: 'Eight weighted pillars that add up to 100, each one a capability an assistant has to have to serve you: read your prices, know your stock, authenticate, and place an order. Every check returns its own points, the evidence it used, and a copy-pasteable fix.',
  },
  {
    q: 'Is this a real measurement or marketing?',
    a: 'The scan is real and reproducible — anyone can run `agentready scan yoursite.com` and get the same number. The agent-simulation part is a simulation: we replay queries against a model with only your site content in context, and we label it as such in every report. It is a good proxy for agent visibility, not a measurement of live ChatGPT traffic.',
  },
  {
    q: 'Do I need an API key to try it?',
    a: 'No. The scanner runs with zero configuration. A free Groq key (console.groq.com/keys) enables real agent simulation; without one, simulation falls back to estimating answerability from your site structure and says so explicitly.',
  },
  {
    q: 'What does "generate an MCP server" actually produce?',
    a: 'A single self-contained JavaScript file that implements the Model Context Protocol over HTTP, with search_products, get_product, check_availability, get_pricing and place_order wired to your catalogue. It deploys to Cloudflare Workers (100k requests/day free) with no dependencies and no build step.',
  },
  {
    q: 'Do I have to give you my data or my credentials?',
    a: 'No. Generation runs on your machine from a CSV, JSON file, API you control, or a public page you point at. Deployment uses your own Cloudflare or Smithery account. We never proxy your catalogue.',
  },
  {
    q: 'What happens on the free tier after one scan?',
    a: 'We ask you to upgrade. The scan limit is 1/month on free, 50/month on Starter and 1,000/month on Business. Your public verification page stays up either way.',
  },
];

export const METRICS = [
  { n: '8', l: 'weighted readiness pillars' },
  { n: '5', l: 'commerce tools generated' },
  { n: '3', l: 'public MCP registries' },
  { n: '$0', l: 'to run the scanner' },
];

export const NAV = [
  { href: '/', label: 'Home' },
  { href: '/#pillars', label: 'How it works' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/dashboard', label: 'Dashboard' },
];

export const SITE = {
  name: 'AgentReady',
  tagline: 'SEO for agents. Be found by AI.',
  description:
    'Score your website out of 100 for AI readability, generate an MCP server from your catalogue, and register it so assistants can find, quote and buy from you.',
};