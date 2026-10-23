import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Role, View } from '@phub/contracts';

export interface Principal {
  subject: string;
  roles: Role[];
}

/** Resolves the caller from request headers; null means unauthenticated. */
export type Authenticator = (headers: { authorization?: string | undefined }) => Promise<Principal | null>;

export const VIEW_ROLE: Record<View, Role> = {
  executive: 'analytics:exec',
  engagement: 'analytics:exec',
  marketing: 'analytics:marketing',
  it: 'analytics:it',
  cdp: 'analytics:cdp',
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

/** Bearer JWT, verified against the identity provider's keys. Roles come from one claim. */
export function jwtAuthenticator(options: {
  keys: JWTVerifyGetKey;
  issuer?: string | undefined;
  audience?: string | undefined;
  rolesClaim: string;
}): Authenticator {
  return async (headers) => {
    const match = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '');
    const token = match?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, options.keys, {
        ...(options.issuer ? { issuer: options.issuer } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
      });
      const claim = payload[options.rolesClaim];
      const values = Array.isArray(claim) ? claim : typeof claim === 'string' ? claim.split(/[\s,]+/) : [];
      return { subject: typeof payload.sub === 'string' ? payload.sub : '', roles: values.filter(isRole) };
    } catch {
      return null;
    }
  };
}
