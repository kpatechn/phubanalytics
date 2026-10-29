import type { Problem } from '@phub/contracts';

// Failures that mean "a data source can't be reached right now", not a bug: the caller gets a 503
// that says which source and what usually fixes it, instead of a bare 500. Host names stay in the log.

/** Network failures from Node (DNS, sockets) and postgres.js (connect timeouts, dropped connections). */
const NETWORK = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
]);

/** AWS SDK errors when the server's own AWS credentials are missing or expired. */
const CREDENTIALS = new Set(['CredentialsProviderError', 'ExpiredTokenException', 'ExpiredToken', 'UnrecognizedClientException']);

function codeOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Which data source a path reads, in the words the screen should use. */
function sourceFor(path: string): { name: string; hint: string } {
  if (path.startsWith('/api/cdp/')) {
    return { name: 'the Chickasaw CDP database', hint: 'It is only reachable over the VPN: check the VPN is connected, then try again.' };
  }
  if (path.startsWith('/api/reinvestment/')) {
    return { name: 'the serving database', hint: 'A network change can do this for a moment: try again.' };
  }
  return { name: 'the analytics database', hint: 'A network or VPN change can do this for a moment: try again.' };
}

/**
 * A 503 problem for an unreachable data source, and how many seconds until a retry may work (none when
 * someone has to act first); null when the error is something else.
 */
export function unavailable(error: unknown, path: string): { problem: Problem; retryAfter?: number } | null {
  const name = error instanceof Error ? error.name : '';
  if (CREDENTIALS.has(name)) {
    return {
      problem: {
        type: 'about:blank',
        title: 'AWS sign-in expired',
        status: 503,
        detail: "The server's AWS credentials are missing or expired. Running locally: aws login --profile playerhub-dev, then try again.",
      },
    };
  }
  if (name === 'DatabaseResumingException') {
    return {
      problem: { type: 'about:blank', title: 'Database starting', status: 503, detail: 'The serving database is starting up. Try again in a minute.' },
      retryAfter: 60,
    };
  }
  const code = codeOf(error);
  if (code && NETWORK.has(code)) {
    const source = sourceFor(path);
    return {
      problem: { type: 'about:blank', title: 'Database unreachable', status: 503, detail: `Can't reach ${source.name} right now. ${source.hint}` },
      retryAfter: 10,
    };
  }
  return null;
}
