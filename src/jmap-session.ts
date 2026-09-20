// JMAP session bootstrap + the request helper every other module builds on.

export const SESSION_URL = "https://api.fastmail.com/jmap/session";
export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";

export interface Session {
  apiUrl: string;
  accountId: string;
  authHeaders: Record<string, string>;
}

export async function bootstrapSession(token: string): Promise<Session> {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const res = await fetch(SESSION_URL, { headers: authHeaders });
  if (!res.ok) {
    throw new Error(`Session bootstrap failed: ${res.status} ${await res.text()}`);
  }
  const session = await res.json();
  const accountId = session.primaryAccounts?.[MAIL];
  if (!accountId) {
    throw new Error(`Session response has no primary account for ${MAIL}`);
  }
  return { apiUrl: session.apiUrl, accountId, authHeaders };
}

export async function jmapRequest(session: Session, using: string[], methodCalls: unknown[]) {
  const res = await fetch(session.apiUrl, {
    method: "POST",
    headers: { ...session.authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) {
    throw new Error(`JMAP request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
