// Agent auth client.
//
// One stable spot for everything that touches the worker auth surface:
//   * device fingerprint generation + persistence
//   * request-otp / verify-otp wire calls
//   * token storage + retrieval
//   * `authedFetch` wrapper that pins the device header + Bearer token
//
// Token + fingerprint persist to localStorage. On logout, both are
// cleared. The worker's JWT carries the device fingerprint hash so a
// stolen token from a different device is rejected at the boundary.

const TOKEN_KEY = 'openballot.agent.token';
const TOKEN_EXP_KEY = 'openballot.agent.token_exp';
const DEVICE_KEY = 'openballot.agent.device';

const WORKER =
  process.env.NEXT_PUBLIC_WORKER_URL ?? 'http://localhost:8000';

function uuidv4() {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID();
  }
  // RFC4122-ish fallback for older environments.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' + hex.slice(4, 6).join('') +
    '-' + hex.slice(6, 8).join('') +
    '-' + hex.slice(8, 10).join('') +
    '-' + hex.slice(10, 16).join('')
  );
}

function getOrCreateDeviceFingerprint(): string {
  if (typeof window === 'undefined') return '';
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const fresh = uuidv4();
  localStorage.setItem(DEVICE_KEY, fresh);
  return fresh;
}

export interface AgentProfile {
  id: string;
  role: string;
  full_name: string;
  party_code: string | null;
  assigned_pu_code: string | null;
}

export async function requestOtp(phone: string): Promise<{ expires_in_seconds: number }> {
  const r = await fetch(`${WORKER}/v1/auth/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new AuthError(r.status, j.detail?.code || 'request_failed', j.detail);
  }
  return r.json();
}

export async function verifyOtp(
  phone: string,
  code: string
): Promise<{ token: string; expires_at: string; agent: AgentProfile }> {
  const fp = getOrCreateDeviceFingerprint();
  const r = await fetch(`${WORKER}/v1/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, device_fingerprint: fp }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new AuthError(r.status, j.detail?.code || 'verify_failed', j.detail);
  }
  const j = await r.json();
  localStorage.setItem(TOKEN_KEY, j.token);
  localStorage.setItem(TOKEN_EXP_KEY, j.expires_at);
  return j;
}

export function currentToken(): string | null {
  if (typeof window === 'undefined') return null;
  const t = localStorage.getItem(TOKEN_KEY);
  const exp = localStorage.getItem(TOKEN_EXP_KEY);
  if (!t || !exp) return null;
  if (new Date(exp).getTime() <= Date.now()) {
    logout();
    return null;
  }
  return t;
}

export function logout(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
}

export async function authedFetch(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
  const token = currentToken();
  const fp = getOrCreateDeviceFingerprint();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-Device-Fingerprint', fp);
  return fetch(input, { ...init, headers });
}

export class AuthError extends Error {
  status: number;
  code: string;
  detail: unknown;
  constructor(status: number, code: string, detail: unknown) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
