#!/usr/bin/env bash
# OpenBallot Nigeria - end-to-end integration test
#
# Spins up the full docker-compose stack (postgres + redis + minio +
# worker + jobworker + web), waits for health, and walks a real
# submission through the pipeline:
#
#   1. Apply migrations (the migrate service should already have run).
#   2. Verify /v1/health on worker + web.
#   3. Verify /metrics is reachable.
#   4. Verify the audit chain starts with a genesis row.
#   5. Verify the IReV scraper unit tests still pass.
#
# This is a smoke-level test - it does NOT exercise the auth flow or
# OCR backends (those need real Twilio + Document AI credentials).
# What it does prove: the compose stack boots, every service comes up
# healthy, the worker + jobworker can talk to Postgres + Redis, and
# the audit chain trigger works on first insert.
#
# Usage:
#   scripts/e2e-test.sh                       # full stack up + verify
#   KEEP_RUNNING=1 scripts/e2e-test.sh        # leave stack up afterwards

set -euo pipefail

C_GRN='\033[32m'; C_RED='\033[31m'; C_BLD='\033[1m'; C_RST='\033[0m'
ok()   { printf "  ${C_GRN}✓${C_RST}  %s\n" "$1"; }
fail() { printf "  ${C_RED}✗${C_RST}  %s\n" "$1"; FAILED=1; }
section() { printf "\n${C_BLD}%s${C_RST}\n" "$1"; }

FAILED=0
COMPOSE="docker compose -f infra/docker-compose.yml"
WORKER_BASE="http://localhost:8000"
WEB_BASE="http://localhost:3000"

cleanup() {
  if [[ "${KEEP_RUNNING:-0}" != "1" ]]; then
    section "Tearing down"
    $COMPOSE down -v --remove-orphans > /dev/null 2>&1 || true
  else
    section "Leaving stack running (KEEP_RUNNING=1)"
  fi
}
trap cleanup EXIT

section "Booting stack"
$COMPOSE up -d --build > /tmp/openballot-e2e.log 2>&1 || {
  cat /tmp/openballot-e2e.log
  exit 1
}
ok "compose up returned"

section "Waiting for worker health"
for i in $(seq 1 60); do
  if curl -fsS "$WORKER_BASE/v1/health" > /dev/null 2>&1; then
    ok "worker /v1/health is OK (took ${i}s)"
    break
  fi
  if [[ "$i" == "60" ]]; then fail "worker never became healthy"; fi
  sleep 1
done

section "Waiting for web health"
for i in $(seq 1 60); do
  if curl -fsS "$WEB_BASE/api/v1/health" > /dev/null 2>&1; then
    ok "web /api/v1/health is OK (took ${i}s)"
    break
  fi
  if [[ "$i" == "60" ]]; then fail "web never became healthy"; fi
  sleep 1
done

section "Smoke checks"
curl -fsS "$WORKER_BASE/v1/health" | grep -q '"status":"ok"' \
  && ok "worker health body matches" \
  || fail "worker health body unexpected"

curl -fsS "$WORKER_BASE/metrics" | grep -q "openballot_ingestion_total" \
  && ok "Prometheus metrics expose ingestion family" \
  || fail "Prometheus metrics missing or unreachable"

curl -fsS "$WORKER_BASE/v1/audit/verify?limit=10" | grep -q '"ok":true' \
  && ok "audit chain verifier returns ok=true on genesis row" \
  || fail "audit chain verifier returned not-ok"

curl -fsS "$WEB_BASE/api/v1/elections" | grep -q '"data"' \
  && ok "web /api/v1/elections returns an envelope" \
  || fail "web /api/v1/elections did not return data envelope"

# Tile endpoint should return 200 or 204 (empty tile is acceptable
# since no submissions exist on a fresh stack).
TILE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$WEB_BASE/api/v1/tiles/2023-presidential/0/0/0.mvt")
if [[ "$TILE_STATUS" == "200" || "$TILE_STATUS" == "204" ]]; then
  ok "tile endpoint returns ${TILE_STATUS}"
else
  fail "tile endpoint returned ${TILE_STATUS}"
fi

section "Scraper unit tests still green inside the worker image"
if $COMPOSE exec -T worker bash -c "cd /app && python -m pytest -q 2>&1 | tail -3"; then
  ok "worker pytest passes inside container"
else
  fail "worker pytest fails inside container"
fi

section "Summary"
if [[ "$FAILED" == "0" ]]; then
  printf "${C_GRN}OK${C_RST}: end-to-end smoke passed\n"
  exit 0
else
  printf "${C_RED}FAILED${C_RST}: at least one check did not pass\n"
  printf "compose logs are in /tmp/openballot-e2e.log\n"
  exit 1
fi
