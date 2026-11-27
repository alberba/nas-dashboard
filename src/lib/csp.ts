/**
 * Builds the Content Security Policy for HTML documents.
 *
 * It is pure on purpose: the proxy imports it, the header structure test
 * exercises it, and neither has to start Next to know what the policy says.
 *
 * `style-src` keeps `'unsafe-inline'` because the dashboard serializes
 * data-driven `style` attributes (percentage widths in charts and resource
 * panels) into the server-rendered HTML; without it those attributes would be
 * blocked. There is no `upgrade-insecure-requests`: local development and
 * Playwright run over `http://localhost`, and HSTS covers the rest.
 */
export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (isDev) scriptSources.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
