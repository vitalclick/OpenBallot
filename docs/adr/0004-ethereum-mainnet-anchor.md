# ADR-0004: Ethereum mainnet for anchor publication

- **Status**: Accepted
- **Date**: 2026-02-02
- **Deciders**: Technical lead, security reviewer

## Context

The SQL audit chain (ADR-0003) prevents tampering by anyone who lacks
DB access. It does NOT prevent OpenBallot operators themselves from
rewriting history in collusion. We need a third-party-verifiable
witness layer outside our infrastructure.

## Decision

**Merkle roots of audit_log batches are anchored to Ethereum mainnet
every 30 minutes during active elections (10 minutes during peak).**
The anchor transaction is an EIP-1559 zero-value self-send carrying
the root as `data`. Block number + TX hash land in `audit_anchors`.

After confirmation, any third party can:
1. Take any audit_log batch they care about,
2. Re-compute the Merkle root locally,
3. Look up the recorded TX on Etherscan,
4. Confirm the root in the TX matches.

If the published audit dataset disagrees with what's in the TX, the
on-chain witness wins.

## Alternatives considered

- **Bitcoin OP_RETURN**: rejected. Slower confirmation times and
  higher fees during peak. Ethereum's mempool dynamics are well-
  understood, and the gas-price ceiling logic (`ANCHOR_MAX_GAS_GWEI`)
  lets us defer anchoring through fee spikes.
- **Solana / cheaper L1**: rejected. Lower public mind-share among
  Nigerian journalists and tribunals; the witness layer needs to be
  trusted by people who are not in the crypto community.
- **Internal-only signed receipts**: rejected. Defeats the purpose -
  the witness needs to be outside our control.
- **Public IPFS pinning**: rejected. IPFS pinning has no immutability
  guarantee; pinned content can be unpinned.

## Consequences

**Easy**: anyone with an Etherscan tab can verify a batch. We never
have to be trusted on the witness layer.

**Hard**: gas cost (~$2.50 per anchor at typical fees; ~$240 per
election). Worker must hold a funded wallet; that wallet is a
narrowly-scoped attack surface documented in DEPLOYMENT_INFO.md.

**Locked-in**: Ethereum mainnet stability. We have a fallback path
(skip anchor when `ANCHOR_ENABLED=false` or RPC unreachable; the SQL
chain remains intact in that case) but the public claim "anchored to
Ethereum" requires Ethereum to keep existing.

## References

- `worker/app/audit/ethereum_client.py` - the signer
- `worker/app/audit/cron.py` - the two-phase idempotent driver
- `worker/cli/anchor.py` - the cron entrypoint
- `docs/DEPLOYMENT_INFO.md` § Ethereum
