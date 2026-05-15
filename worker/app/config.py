from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    # Postgres
    database_url: str = Field(
        default="postgresql://openballot:openballot@db:5432/openballot",
        description="Async asyncpg connection string",
    )

    # Redis / queue
    redis_url: str = Field(default="redis://redis:6379/0")

    # Object storage
    storage_bucket: str = Field(default="ec8a-evidence")
    storage_endpoint: str = Field(default="http://minio:9000")
    storage_access_key: str = Field(default="minioadmin")
    storage_secret_key: str = Field(default="minioadmin")

    # AI extractors
    google_document_ai_project: str | None = None
    google_document_ai_processor: str | None = None
    openai_api_key: str | None = None

    # Blockchain anchoring
    ethereum_rpc_url: str | None = None
    ethereum_anchor_address: str | None = None
    anchor_batch_interval_seconds: int = 1800  # 30 minutes during active elections
    anchor_enabled: bool = False  # gate so dev environments don't try to send TXs

    # Ingestion thresholds
    gps_geofence_metres: int = 100              # warn beyond this
    gps_hard_block_metres: int = 2_000          # discard beyond this
    min_image_bytes: int = 60_000               # below this is almost certainly thumbnail
    max_image_bytes: int = 12_000_000           # cap upload payload
    extraction_confidence_floor: float = 0.85   # below this routes to human review
    consensus_min_sources: int = 2              # parties/observers required for consensus
    consensus_tolerance_votes: int = 0          # exact agreement required by default

    # Auth
    agent_jwt_secret: str = Field(
        default="dev-only-change-me-in-prod-or-via-env",
        description="HMAC secret for agent JWTs. MUST be overridden in production.",
    )
    agent_jwt_ttl_seconds: int = 60 * 60 * 24   # 24h - re-auth daily during elections
    otp_length: int = 6
    otp_ttl_seconds: int = 300                  # 5 minutes
    otp_max_attempts: int = 5                   # per OTP code
    otp_max_requests_per_phone_per_10min: int = 3
    otp_max_requests_per_ip_per_hour: int = 30

    twilio_account_sid: str | None = None
    twilio_auth_token: str | None = None
    twilio_from: str | None = None
    twilio_enabled: bool = False                # toggle real Twilio in prod

    # Operational
    log_level: str = "INFO"
    environment: str = "development"


@lru_cache
def settings() -> Settings:
    return Settings()
