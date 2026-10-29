import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Role, View } from '@phub/contracts';

export interface Principal {
  subject: string;
  roles: Role[];
}

export type Headers = Record<string, string | string[] | undefined>;

/** Resolves the caller from request headers; null means unauthenticated. */
export type Authenticator = (headers: Headers) => Promise<Principal | null>;

export const VIEW_ROLE: Record<View, Role> = {
  executive: 'analytics:exec',
  engagement: 'analytics:exec',
  marketing: 'analytics:marketing',
  it: 'analytics:it',
  cdp: 'analytics:cdp',
  reinvestment: 'analytics:marketing',
};

const ALL_ROLES: ReadonlySet<string> = new Set<Role>(['analytics:exec', 'analytics:marketing', 'analytics:it', 'analytics:cdp', 'analytics:admin']);

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && ALL_ROLES.has(value);
}

export function canView(principal: Principal, view: View): boolean {
  return principal.roles.includes('analytics:admin') || principal.roles.includes(VIEW_ROLE[view]);
}

export function viewsFor(principal: Principal): View[] {
  return (Object.keys(VIEW_ROLE) as View[]).filter((view) => canView(principal, view));
}

/** Development only (config refuses it elsewhere): every caller is an admin. */
export function devAuthenticator(): Authenticator {
  return async () => ({ subject: 'dev-user', roles: ['analytics:admin'] });
}

/** The token from the Authorization header (Bearer) or, behind a sign-in proxy, from the header it sets. */
function tokenFrom(headers: Headers, header: string): string | null {
  const value = headers[header];
  if (typeof value !== 'string') return null;
  if (header === 'authorization') return /^Bearer\s+(\S+)$/i.exec(value)?.[1] ?? null;
  return /^\S+$/.test(value) ? value : null;
}

/** JWT verified against the identity provider's keys. Roles come from one claim. */
export function jwtAuthenticator(options: {
  keys: JWTVerifyGetKey;
  issuer?: string | undefined;
  audience?: string | undefined;
  rolesClaim: string;
  /** Header carrying the token; 'authorization' (the default) means a Bearer token. */
  tokenHeader?: string | undefined;
  /** Cognito access tokens: the app client they were issued to. */
  clientId?: string | undefined;
  subjectClaim?: string | undefined;
}): Authenticator {
  const header = options.tokenHeader ?? 'authorization';
  const subjectClaim = options.subjectClaim ?? 'sub';
  return async (headers) => {
    const token = tokenFrom(headers, header);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        ...(options.issuer ? { issuer: options.issuer } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
      });
      if (options.clientId && payload['client_id'] !== options.clientId) return null;
      const claim = payload[options.rolesClaim];
      const values = Array.isArray(claim) ? claim : typeof claim === 'string' ? claim.split(/[\s,]+/) : [];
      const subject = payload[subjectClaim];
      return { subject: typeof subject === 'string' ? subject : '', roles: values.filter(isRole) };
    } catch {
      return null;
    }
  };
}
