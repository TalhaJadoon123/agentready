/**
 * Pillar 7 — Machine authentication.
 *
 * An agent calling your API needs a key. We probe the OAuth discovery documents
 * an RFC 8414 client looks for, and look for API-key affordances in the docs.
 * No discovery endpoint means agents either scrape a login page or give up.
 */

import { buildResult, partial } from './base.js';
import type { ScanContext } from '../context.js';

export async function checkAuth(ctx: ScanContext) {
  const authServer = ctx.wellKnown['/.well-known/oauth-authorization-server'];
  const protectedResource = ctx.wellKnown['/.well-known/oauth-protected-resource'];

  const hasAuthServer = Boolean(authServer?.ok);
  const hasProtectedResource = Boolean(protectedResource?.ok);

  let grants: string[] = [];
  let tokenEndpoint: string | undefined;
  if (hasAuthServer && authServer?.body) {
    try {
      const doc = JSON.parse(authServer.body) as Record<string, unknown>;
      grants = Array.isArray(doc['grant_types_supported']) ? (doc['grant_types_supported'] as unknown[]).map(String) : [];
      tokenEndpoint = typeof doc['token_endpoint'] === 'string' ? doc['token_endpoint'] : undefined;
    } catch {
      grants = [];
    }
  }

  // client_credentials is what an unattended agent-to-business call needs.
  const supportsClientCredentials = grants.includes('client_credentials');
  const supportsAuthCode = grants.includes('authorization_code');
  const supportsApiKey =
    grants.includes('urn:ietf:params:oauth:grant-type:jwt-bearer') || grants.includes('api_key');

  // A login form is the human path; it is not machine auth, but its absence
  // alongside no OAuth suggests a fully closed site.
  const hasLoginForm = ctx.page.hasLoginForm;
  const documentsApiKey = /\b(api[\s_-]?key|bearer[\s_-]?token|access[\s_-]?token|oauth|client[\s_-]?credentials)\b/i.test(
    `${ctx.page.text.slice(0, 20_000)}`,
  );

  // Points: 2 auth server discovery, 2 protected resource metadata,
  //         2 client_credentials, 1 documented key path.
  let points = 0;
  points += hasAuthServer ? 2 : 0;
  points += hasProtectedResource ? 2 : 0;
  points += 2 * partial(supportsClientCredentials ? 1 : 0, 1);
  points += documentsApiKey || supportsApiKey ? 1 : 0;

  const status = hasAuthServer && supportsClientCredentials ? 'pass' : hasAuthServer || hasProtectedResource ? 'warn' : 'fail';

  const fixes: string[] = [];
  if (!hasAuthServer) {
    fixes.push('Publish /.well-known/oauth-authorization-server (RFC 8414) describing your token endpoint and supported grants.');
  }
  if (!hasProtectedResource) {
    fixes.push('Publish /.well-known/oauth-protected-resource (RFC 9728) so agents know which resource to get a token for.');
  }
  if (hasAuthServer && !supportsClientCredentials) {
    fixes.push('Add the client_credentials grant — it is how an unattended agent authenticates.');
  }
  if (!documentsApiKey && !supportsApiKey) {
    fixes.push('Document how to obtain a key (API key, bearer token) in your docs or llms.txt.');
  }
  if (hasLoginForm && !hasAuthServer) {
    fixes.push('You have a human login form but no machine auth — add OAuth client_credentials alongside it.');
  }

  const summary = hasAuthServer
    ? `OAuth discovery present (grants: ${grants.join(', ') || 'unspecified'}).`
    : hasProtectedResource
      ? 'OAuth protected-resource metadata present, but no authorization-server discovery.'
      : hasLoginForm
        ? 'Only human login is supported. Agents cannot authenticate.'
        : 'No machine authentication found — an agent cannot prove who it is.';

  return buildResult(
    'auth',
    status,
    points,
    summary,
    fixes,
    {
      hasAuthServer,
      hasProtectedResource,
      grants,
      tokenEndpoint: tokenEndpoint ?? null,
      supportsClientCredentials,
      supportsAuthCode,
      hasLoginForm,
      documentsApiKey,
    },
  );
}