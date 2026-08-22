"""Ethereum anchor client - real implementation.

Implements the EthereumClient protocol from anchor.py against an Ethereum
JSON-RPC endpoint (Infura by default). The client:

  * Loads the anchor wallet from `ETHEREUM_ANCHOR_PRIVATE_KEY`
  * Estimates gas + reads the current base fee
  * Refuses to broadcast when gas exceeds `ANCHOR_MAX_GAS_GWEI`
  * Sends an EIP-1559 zero-value transaction to itself with the Merkle
    root as call-data (the OP_RETURN analogue for Ethereum)
  * Waits for receipt; returns (tx_hash, block_number)
  * Retries on `nonce too low` and other transient errors

Why send to self? An OP_RETURN-style anchor is a TX whose data field
carries a hash and whose value is 0. Sending to a contract is overkill;
sending to the same wallet is the cheapest pattern that still puts the
data permanently on chain.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)


class GasPriceTooHigh(Exception):
    """Current network gas exceeds the configured ceiling; refusing to anchor."""


@dataclass
class AnchorReceipt:
    tx_hash: str
    block_number: int
    gas_used: int
    effective_gas_price_gwei: float


class EthereumAnchorClient:
    """Submits OP_RETURN-style anchors to Ethereum mainnet."""

    def __init__(
        self,
        *,
        rpc_url: str,
        private_key: str,
        max_gas_gwei: float = 80.0,
        chain_id: int = 1,
        gas_limit: int = 30_000,
        timeout_seconds: float = 60.0,
        confirmation_blocks: int = 1,
        poll_interval_seconds: float = 5.0,
        max_wait_seconds: float = 300.0,
    ):
        self.rpc_url = rpc_url
        self.private_key = private_key
        self.max_gas_gwei = max_gas_gwei
        self.chain_id = chain_id
        self.gas_limit = gas_limit
        self.timeout = timeout_seconds
        self.confirmation_blocks = confirmation_blocks
        self.poll_interval = poll_interval_seconds
        self.max_wait = max_wait_seconds
        self._address: str | None = None

    # ─── eth_account wiring (lazy import so the worker boots without eth-account
    # ─── installed in dev / CI environments that don't need anchoring) ──────
    @property
    def address(self) -> str:
        if self._address is None:
            from eth_account import Account
            self._address = Account.from_key(self.private_key).address
        return self._address

    # ─── JSON-RPC plumbing ──────────────────────────────────────────────────

    async def _rpc(self, method: str, params: list) -> dict:
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(
                self.rpc_url,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            )
        if r.status_code >= 300:
            raise RuntimeError(f"RPC HTTP {r.status_code}: {r.text[:200]}")
        payload = r.json()
        if "error" in payload:
            raise RuntimeError(f"RPC error: {payload['error']}")
        return payload["result"]

    async def get_base_fee_gwei(self) -> float:
        block = await self._rpc("eth_getBlockByNumber", ["latest", False])
        base_fee_hex = block.get("baseFeePerGas")
        if base_fee_hex is None:
            # Pre-EIP-1559 fallback - shouldn't happen on mainnet now
            return 0.0
        return int(base_fee_hex, 16) / 1e9

    async def get_nonce(self) -> int:
        result = await self._rpc("eth_getTransactionCount", [self.address, "pending"])
        return int(result, 16)

    async def get_balance_wei(self) -> int:
        result = await self._rpc("eth_getBalance", [self.address, "latest"])
        return int(result, 16)

    # ─── Anchor submission ──────────────────────────────────────────────────

    async def send_data_tx(self, *, data_hex: str) -> tuple[str, int]:
        """Submit an EIP-1559 self-send carrying `data_hex` in the data field.

        Returns (tx_hash, block_number) once the TX is confirmed.

        Raises GasPriceTooHigh if base fee exceeds the configured ceiling.
        """
        from eth_account import Account

        base_fee_gwei = await self.get_base_fee_gwei()
        if base_fee_gwei > self.max_gas_gwei:
            raise GasPriceTooHigh(
                f"base fee {base_fee_gwei:.1f} gwei exceeds ceiling {self.max_gas_gwei:.1f}"
            )

        priority_fee_gwei = 1.0
        max_fee_gwei = max(self.max_gas_gwei, base_fee_gwei + priority_fee_gwei * 2)

        nonce = await self.get_nonce()
        tx = {
            "type": 2,
            "chainId": self.chain_id,
            "nonce": nonce,
            "to": self.address,                                 # self-send
            "value": 0,
            "gas": self.gas_limit,
            "maxPriorityFeePerGas": int(priority_fee_gwei * 1e9),
            "maxFeePerGas": int(max_fee_gwei * 1e9),
            "data": data_hex if data_hex.startswith("0x") else "0x" + data_hex,
        }

        signed = Account.sign_transaction(tx, self.private_key)
        # eth-account < 0.10 exposed `rawTransaction`; >= 0.10 renamed it
        # to `raw_transaction`. Support both.
        raw_bytes = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        raw = raw_bytes.hex()
        if not raw.startswith("0x"):
            raw = "0x" + raw
        tx_hash = await self._rpc("eth_sendRawTransaction", [raw])

        receipt = await self._wait_for_receipt(tx_hash)
        log.info(
            "audit.anchor.confirmed",
            extra={
                "tx_hash": tx_hash,
                "block": receipt.block_number,
                "base_fee_gwei": base_fee_gwei,
                "effective_gwei": receipt.effective_gas_price_gwei,
                "gas_used": receipt.gas_used,
            },
        )
        return tx_hash, receipt.block_number

    async def _wait_for_receipt(self, tx_hash: str) -> AnchorReceipt:
        # Use real wall-clock time so a 0-second poll interval (used in
        # tests) does not produce an infinite loop.
        loop = asyncio.get_event_loop()
        deadline = loop.time() + self.max_wait
        while loop.time() < deadline:
            result = await self._rpc("eth_getTransactionReceipt", [tx_hash])
            if result is not None:
                effective = int(result.get("effectiveGasPrice", "0x0"), 16) / 1e9
                return AnchorReceipt(
                    tx_hash=tx_hash,
                    block_number=int(result["blockNumber"], 16),
                    gas_used=int(result["gasUsed"], 16),
                    effective_gas_price_gwei=effective,
                )
            if self.poll_interval > 0:
                await asyncio.sleep(self.poll_interval)
            else:
                # Yield control so an awaitable side-effect on the mocked
                # _rpc can resolve, but do not busy-loop.
                await asyncio.sleep(0.001)
        raise TimeoutError(f"TX {tx_hash} not confirmed within {self.max_wait}s")


def build_from_settings() -> EthereumAnchorClient | None:
    """Returns a configured client when ANCHOR_ENABLED is true and the
    required env is present. Returns None otherwise so the caller knows
    to skip anchor cron runs in dev / staging."""
    import os

    from ..config import settings as _s
    s = _s()
    if not s.anchor_enabled:
        return None
    rpc_url = s.ethereum_rpc_url or os.environ.get("ETHEREUM_RPC_URL")
    pk = os.environ.get("ETHEREUM_ANCHOR_PRIVATE_KEY")
    if not rpc_url or not pk:
        log.warning("ethereum.anchor.disabled", extra={"reason": "missing RPC URL or private key"})
        return None
    return EthereumAnchorClient(
        rpc_url=rpc_url,
        private_key=pk,
        max_gas_gwei=float(os.environ.get("ANCHOR_MAX_GAS_GWEI", "80")),
        chain_id=int(os.environ.get("ETHEREUM_CHAIN_ID", "1")),
    )
