import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Who may talk to the control plane.
 *
 * The server can run arbitrary commands on the cluster, so every request must
 * prove three things: it was addressed to us (Host), it was not sent by another
 * site's page (Origin), and the caller holds this launch's token (cookie).
 */
export interface AccessPolicy {
  token: string;
  cookieName: string;
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
}

export type AccessDenial = "host" | "origin" | "auth";

const MIN_TOKEN_LENGTH = 24;
const COOKIE_MAX_AGE_SEC = 30 * 24 * 3600;

export function createAccessPolicy(port: number, pinnedToken?: string): AccessPolicy {
  if (pinnedToken !== undefined && pinnedToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`SPARKPIT_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  return {
    token: pinnedToken ?? randomBytes(32).toString("base64url"),
    // Cookies ignore ports, so the name carries it to keep instances apart.
    cookieName: `sparkpit_${port}`,
    allowedHosts: new Set(hosts),
    allowedOrigins: new Set(hosts.map((h) => `http://${h}`)),
  };
}

export function tokenMatches(candidate: string | null | undefined, policy: AccessPolicy): boolean {
  if (!candidate) return false;
  const given = Buffer.from(candidate);
  const expected = Buffer.from(policy.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function hostAllowed(req: Request, policy: AccessPolicy): boolean {
  return policy.allowedHosts.has(req.headers.get("host") ?? "");
}

/** Returns why the request is refused, or null when it may proceed. */
export function checkAccess(req: Request, policy: AccessPolicy): AccessDenial | null {
  if (!hostAllowed(req, policy)) return "host";
  // Browsers attach Origin to every cross-site request and WebSocket upgrade.
  // Its absence means a same-origin GET or a non-browser client; both still need the token.
  const origin = req.headers.get("origin");
  if (origin !== null && !policy.allowedOrigins.has(origin)) return "origin";
  if (!tokenMatches(readCookie(req.headers.get("cookie"), policy.cookieName), policy)) return "auth";
  return null;
}

export function sessionCookie(policy: AccessPolicy): string {
  return `${policy.cookieName}=${policy.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}`;
}
