-- OpenBallot Nigeria - Migration 0007
-- Agent authentication: OTP storage, login attempt log, device fingerprints.

BEGIN;

-- One row per OTP request. Code is stored as a SHA-256 hash (with a per-row
-- salt) - we never store the raw 6-digit value.
CREATE TABLE agent_otps (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_e164       TEXT NOT NULL,
  code_hash        CHAR(64) NOT NULL,
  code_salt        CHAR(32) NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  consumed_at      TIMESTAMPTZ,
  requested_ip     TEXT,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_otp_phone_active ON agent_otps (phone_e164, requested_at DESC)
  WHERE consumed_at IS NULL;
CREATE INDEX idx_otp_expires      ON agent_otps (expires_at);

-- Auth events for rate limiting + anomaly detection.
CREATE TABLE auth_events (
  id           BIGSERIAL PRIMARY KEY,
  phone_e164   TEXT,
  agent_id     UUID REFERENCES agents(id),
  event_type   TEXT NOT NULL,         -- otp.requested | otp.verified | otp.failed | login.success | login.denied
  ip_address   TEXT,
  user_agent   TEXT,
  device_fingerprint TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_authev_phone_recent ON auth_events (phone_e164, created_at DESC);
CREATE INDEX idx_authev_ip_recent    ON auth_events (ip_address, created_at DESC);
CREATE INDEX idx_authev_agent        ON auth_events (agent_id, created_at DESC);

-- Per-agent device binding. First successful login records the device
-- fingerprint hash on the agent row. Subsequent logins from a different
-- device land in pending_devices and require re-verification.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE TABLE pending_device_changes (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  new_fingerprint TEXT NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at   TIMESTAMPTZ,
  denied_at     TIMESTAMPTZ
);
CREATE INDEX idx_pending_devices_agent ON pending_device_changes (agent_id, requested_at DESC);

COMMIT;
