"""Migration runner.

Applied on every worker boot. Scans db/migrations/*.sql for files we
haven't applied yet (tracked in `schema_migrations` table), and applies
each one inside an advisory lock so concurrent boots are safe.

Run with:
  python -m cli.migrate
  python -m cli.migrate --status    # show pending migrations, don't apply

The advisory lock has key 5101883 - chosen at random; document it here
so an operator inspecting pg_locks knows what they're looking at.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import sys
from pathlib import Path

import asyncpg

from app.config import settings

log = logging.getLogger(__name__)


ADVISORY_LOCK_KEY = 5101883     # arbitrary 32-bit int
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "db" / "migrations"
POLICIES_DIR = Path(__file__).resolve().parents[2] / "db" / "policies"

MIGRATION_FILENAME_RE = re.compile(r"^(\d{4})_.*\.sql$")


async def ensure_table(conn: asyncpg.Connection) -> None:
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version       TEXT PRIMARY KEY,
          filename      TEXT NOT NULL,
          checksum      CHAR(64) NOT NULL,
          applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def _discover() -> list[Path]:
    if not MIGRATIONS_DIR.exists():
        raise FileNotFoundError(f"migrations dir not found: {MIGRATIONS_DIR}")
    files = []
    for p in sorted(MIGRATIONS_DIR.iterdir()):
        if not MIGRATION_FILENAME_RE.match(p.name):
            continue
        files.append(p)
    return files


def _checksum(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


async def pending_migrations(conn: asyncpg.Connection) -> list[Path]:
    rows = await conn.fetch("SELECT version FROM schema_migrations")
    applied = {r["version"] for r in rows}
    return [p for p in _discover() if _version_of(p) not in applied]


def _version_of(p: Path) -> str:
    m = MIGRATION_FILENAME_RE.match(p.name)
    if not m:
        raise ValueError(f"non-conforming migration filename: {p.name}")
    return m.group(1)


async def apply_one(conn: asyncpg.Connection, path: Path) -> None:
    sql = path.read_text()
    version = _version_of(path)
    checksum = _checksum(sql)
    log.info("migrate.applying", extra={"version": version, "migration_file": path.name})
    # Migrations contain BEGIN/COMMIT explicitly; do not wrap.
    await conn.execute(sql)
    await conn.execute(
        """
        INSERT INTO schema_migrations (version, filename, checksum)
        VALUES ($1, $2, $3)
        """,
        version,
        path.name,
        checksum,
    )


async def apply_pending() -> int:
    db_url = settings().database_url
    # asyncpg sync URL works; if the value uses 'postgresql+asyncpg://'
    # strip the dialect.
    if "+asyncpg" in db_url:
        db_url = db_url.replace("+asyncpg", "")
    conn = await asyncpg.connect(db_url)
    try:
        await ensure_table(conn)

        # Acquire the advisory lock so two worker boots in parallel
        # don't double-apply.
        log.info("migrate.lock_acquiring", extra={"key": ADVISORY_LOCK_KEY})
        await conn.execute("SELECT pg_advisory_lock($1)", ADVISORY_LOCK_KEY)
        try:
            pending = await pending_migrations(conn)
            if not pending:
                log.info("migrate.no_pending")
                return 0
            for p in pending:
                await apply_one(conn, p)
            log.info("migrate.applied_n", extra={"count": len(pending)})
            return len(pending)
        finally:
            await conn.execute("SELECT pg_advisory_unlock($1)", ADVISORY_LOCK_KEY)
    finally:
        await conn.close()


async def show_status() -> None:
    db_url = settings().database_url.replace("+asyncpg", "")
    conn = await asyncpg.connect(db_url)
    try:
        await ensure_table(conn)
        rows = await conn.fetch(
            "SELECT version, filename, applied_at FROM schema_migrations ORDER BY version"
        )
        applied = {r["version"]: r for r in rows}
        all_versions = _discover()
        for p in all_versions:
            v = _version_of(p)
            if v in applied:
                print(f"  [APPLIED]  {v}  {p.name}  ({applied[v]['applied_at']})")
            else:
                print(f"  [PENDING]  {v}  {p.name}")
    finally:
        await conn.close()


async def main() -> None:
    logging.basicConfig(level=settings().log_level)
    if "--status" in sys.argv:
        await show_status()
        return
    count = await apply_pending()
    print(f"migrations applied: {count}")


if __name__ == "__main__":
    asyncio.run(main())
