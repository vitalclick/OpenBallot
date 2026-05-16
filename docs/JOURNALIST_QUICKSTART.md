# Journalist quickstart

OpenBallot Nigeria is a transparency tool. Every result on the platform
is anchored to a signed EC8A and chained into a tamper-evident audit
log. As a journalist you can verify, cite, and download the underlying
data without going through us.

This page is the 10-minute version of how to use it.

## The map states (what colours mean)

| Colour | State | What it means |
|---|---|---|
| ⬜ | `no_data` | No submission of any kind |
| 🟡 | `single_source` | One party agent or observer; not yet cross-verified |
| ◾ | `inec_published` | INEC IReV is the only source on file (typical for concluded 2023 PUs) |
| 🟢 | `consensus` | ≥ 2 independent sources agree |
| 🟦 | `inec_confirmed` | Multi-source consensus AND matches INEC IReV |
| 🟧 | `discrepancy` | ≥ 2 sources disagree |
| 🔴 | `inec_conflict` | Multi-source consensus contradicts INEC's official upload |

The **red `inec_conflict`** state is the most consequential. It is the
Rivers-2023 fabrication detection signal made automatic.

## Cite a specific polling unit

Every polling unit has a stable, shareable URL:

```
https://openballot.ng/en/pu/{pu_code}
```

For example:
```
https://openballot.ng/en/pu/25-11-04-007
```

The page shows:
- Header with verification status + share link
- Consensus result + per-candidate vote totals
- **Every EC8A image** submitted for that PU, side by side, with the
  submitting source (party agent / observer / INEC) labeled
- Every anomaly flagged on the PU with severity
- The last 50 audit-chain events touching the PU
- The SHA-256 manifest for every image, verifiable offline

You can paste this URL into a story and readers can verify the claim
themselves.

## Download the raw data

### Full results CSV (one row per PU × candidate)

```bash
curl -L "https://openballot.ng/api/v1/elections/2023-presidential/results.csv" > results.csv
```

Filter by state at fetch time to keep the file small:

```bash
curl -L "https://openballot.ng/api/v1/elections/2023-presidential/results.csv?state=RI" > rivers.csv
```

19 columns including: state, lga, ward, pu_code, pu_name, party, votes,
leader_share, registered_voters, accredited_voters, total_valid_votes,
rejected_ballots, total_votes_cast, image_sha256, verification_status,
source_count, computed_at.

### SHA-256 hash manifest

```bash
curl -L "https://openballot.ng/api/v1/audit/hashes?election_id=2023-presidential" > manifest.csv
```

Five columns: submission_id, pu_code, party, image_sha256, submitted_at.
You can re-download any EC8A from its URL and verify the hash matches.

### Anomaly register

```bash
curl -L "https://openballot.ng/api/v1/anomalies?election_id=2023-presidential&min_severity=4" \
  | jq '.data[] | {pu_code, anomaly_type, severity, details}'
```

Filter by `?state=`, `?type=`, `?min_severity=`. Anomaly types include
`votes_exceed_registered`, `turnout_outlier_ward`, `inec_conflict`,
`turnout_shift_vs_2023`, `leader_extreme_share`.

### Discrepancy register

```bash
curl -L "https://openballot.ng/api/v1/discrepancies?election_id=2023-presidential" \
  | jq '.data[] | {pu_code, severity, differing_fields, escalation_status}'
```

## Verify the audit chain yourself

The audit chain has a Python implementation that runs entirely
locally - no dependency on OpenBallot's infrastructure:

```bash
# 1. Download the audit CSV (published after election conclusion)
curl -L "https://openballot.ng/audit/2023-presidential/chain.csv" > chain.csv

# 2. Run the standalone verifier (zero dependencies)
python scripts/verify_audit_chain.py chain.csv
```

Output:
```
OK: chain verified
```

Any tampering with any row breaks the chain at the point of the
rewrite.

## Embed the live map

Drop the map into your story with one line:

```html
<iframe src="https://openballot.ng/embed/map?election=2023-presidential"
        width="100%" height="600" frameborder="0"></iframe>
```

Customisable parameters: `election`, `state`, `language`, `centre`,
`zoom`. The iframe respects the `inec_conflict` red states automatically.

## Real-time stream

For story-night live dashboards, subscribe to Server-Sent Events:

```javascript
const es = new EventSource('https://openballot.ng/api/v1/elections/2027-presidential/stream');
es.addEventListener('verified_result', (e) => {
  const data = JSON.parse(e.data);
  console.log(`${data.pu_code} -> ${data.status}`);
});
```

Events arrive within seconds of consensus changing.

## Getting help

- Technical questions: open an issue at
  https://github.com/vitalclick/OpenBallot
- Press enquiries: press@openballot.ng
- A particular polling unit you want clarified: link the
  `/en/pu/{pu_code}` URL in your message; that's the shortest
  path to a specific answer.

## What we will NOT do

- We will not declare election results. INEC declares; OpenBallot
  exposes evidence.
- We will not characterise any discrepancy or anomaly as fraud. We
  surface factual differences; tribunals decide intent.
- We will not take a story off the platform. Anything published is
  permanent. If you find data we have wrong, file a correction and
  we will append, not overwrite.

---

*The form is the truth. The truth is public.*
