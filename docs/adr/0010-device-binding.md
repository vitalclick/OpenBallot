# ADR-0010: Per-install device fingerprinting for agent JWTs

- **Status**: Accepted
- **Date**: 2026-04-01
- **Deciders**: Auth lead, security reviewer

## Context

Agent OTP authentication issues JWTs valid for 24 hours. A leaked
JWT can be replayed from any machine until expiry. At ~250,000
agents on election day, the probability that at least one token
leaks is high; we need a defence that limits the damage.

## Decision

**Each PWA install generates a per-device UUID at first launch
(stored in `localStorage`) and sends it in the `X-Device-Fingerprint`
header on every authenticated request. SHA-256 of that fingerprint
is embedded in the JWT as the `dev` claim.** The auth middleware
rejects any request whose presented fingerprint hash doesn't match
the token's `dev`.

First login records the fingerprint hash on the `agents` row.
Subsequent logins from a different device land in
`pending_device_changes` requiring party-admin approval, rather than
silently rotating.

## Alternatives considered

- **Browser fingerprinting (canvas, fonts, etc.)**: rejected. Brittle
  across browser updates; mostly used for tracking, which is
  reputationally adjacent to what we don't want to be associated with.
- **IP address binding**: rejected. Mobile agents change networks
  constantly during election day.
- **WebAuthn / hardware tokens**: rejected on rollout cost. Most
  Nigerian agents do not have hardware-token-capable devices.
- **Short JWT TTL (5 min) + refresh**: considered. Doesn't help with
  the single-token-replay vector during the 5-minute window; adds
  complexity. Rejected as the sole defence; we use a 24h TTL and
  device binding together.

## Consequences

**Easy**: a stolen token is useless without the matching
`localStorage` value, which is a deliberate user action to clear
(clearing site data).

**Hard**: legitimate device changes (a phone breaks, agent switches
to a relative's device) now require admin approval. We mitigate by
publishing the `pending_device_changes` queue in the admin portal
with a quick-approve flow.

**Locked-in**: clearing site data on an agent's phone forces
re-authentication. This is the desired property — we want clearing
site data to be the explicit "I no longer trust this device"
signal.

## References

- `worker/app/auth/device.py`
- `worker/app/auth/jwt_tokens.py`
- `worker/app/auth/router.py` § verify-otp + require_agent
- `web/lib/auth-client.ts` - per-install UUID generation
