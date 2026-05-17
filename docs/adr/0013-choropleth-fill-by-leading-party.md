# ADR-0013: Choropleth fill = leading party at every level

- **Status**: Accepted
- **Date**: 2026-05-17
- **Deciders**: Engineering

## Context

The public results map drills through four levels — country → state
→ LGA → ward → polling unit. Each region (and each PU) had two
candidate "primary visual variables" competing for the fill colour:

1. **Data quality** (% verified, INEC conflict, discrepancy) — the
   verification semantics the project was originally built around.
   Reflected in `STATUS_COLOURS` and the green-amber ramp in the
   original `regionFill()`.

2. **Election outcome** (the leading party at that region) —
   already computed by the aggregate SQL functions
   (`leader_party`, `leader_share` on `RegionAggregate`) but never
   actually rendered.

The product's purpose is to communicate election results. A user
landing on the map should see the result *first*, with verification
quality available but not in the way. The original fill choice
treated the verification ramp as primary, which inverted that
priority.

A second consideration: when a ward polygon is **bound to the wrong
INEC ward** (low-confidence GRID3 reconciliation — see ADR-0012),
the leader's colour would visually misattribute votes to the wrong
piece of ground. So the fill change isn't just visual; it makes
match quality a correctness concern, not just aesthetic.

## Decision

**Fill = leading party's brand colour at every level (state, LGA,
ward, PU dot). Verification quality moves to the stroke. Low-
confidence ward polygons render with a dashed stroke at reduced
opacity so the boundary is visibly approximate. Regions with no
result yet get a single neutral grey fill, listed in the legend as
"No result".**

The visual hierarchy:

| Glyph | Fill | Stroke | What it communicates |
|---|---|---|---|
| State polygon | leader's brand colour | red INEC-conflict / orange discrepancy / blue focus / slate default | "Who leads this state + how reliable is the count" |
| LGA polygon | same | same | same, one level down |
| Ward polygon (GRID3, conf ≥ 0.95) | same | solid slate | same |
| Ward polygon (GRID3, conf < 0.95) | same, 70% opacity | dashed slate | "+ this boundary is approximate" |
| Ward circle (no polygon) | same | solid slate | same, at centroid |
| PU dot | PU's own leader from `consensus_data.candidate_votes` | red conflict / orange discrepancy / faint slate | "Who won + flagged issues" |
| Any of the above with no result | NO_LEADER_FILL grey | unchanged | "No data yet" |

`web/lib/party-colours.ts` centralises the `partyColour(code,
palette)` helper, the `leaderFromCandidateVotes()` derivation for
PUs, and `DEFAULT_PARTY_PALETTE` as a fallback when the
`/api/v1/parties` endpoint is unreachable. The frontend fetches the
live palette from the `parties` table on map mount; missing party
codes get a neutral `UNKNOWN_PARTY_FILL` instead of an arbitrary
colour.

## Alternatives considered

**(A) Keep verification fill, show leader only in tooltips.**
Rejected. The map is the product's headline communication tool; an
election-results map that doesn't paint by election outcome is
hiding its lede.

**(B) Two layers stacked — solid party fill, semi-transparent
verification overlay on top.** Rejected. Tested mentally: the
result would mix-tone the brand colours unpredictably (LP green +
amber overlay ≠ either colour's identity), undermining both
signals.

**(C) Stripes / hatching for low-confidence polygons instead of
dashed stroke.** Rejected. Hatching obscures the fill colour at
zoomed-out levels and clashes with the proportional-symbol
fallback circles in the same view. A dashed stroke is recognisable
at every zoom level without competing with the fill.

**(D) Drop the fallback circles entirely and just leave gaps
where polygons are missing.** Rejected. The whole point of the
circle fallback is to keep the political signal alive for every
ward — a missing polygon should not look like a missing result.
Empty geography in a leader-painted map reads as "no votes here,"
which is wrong.

## Consequences

**Makes easy:**
- The map's primary purpose (showing who's leading) is immediately
  legible at any zoom level.
- New parties register a colour once in the `parties` table; the
  whole map picks it up via the `/api/v1/parties` fetch — no
  hardcoded palette updates needed.
- Verification info (`INEC conflict`, `discrepancy`) keeps surfacing
  via stroke without competing with the political signal.

**Makes hard:**
- Designing emergency-only colour palettes for "data integrity
  crisis" displays (e.g. when half the country has INEC conflicts)
  is now constrained — the stroke is the only quality channel, so
  we can't use fill colour to escalate.
- Accessibility — party brand colours weren't chosen for
  colourblind safety. A long-tail of new entrants could push us
  into perceptually-overlapping colours. A future pattern-fill
  pass may be needed.
- Reconciliation quality has been promoted from a "polish issue"
  to a "correctness issue" (see ADR-0012). A wrong ward polygon
  now visually lies, so the bar for accepting a fuzzy match is
  higher than it would be if fill were neutral.

**Locks us into:**
- Party brand colours as the canonical region fills. Reverting to
  a verification ramp would mean retraining users on a different
  visual contract.
- The legend's primary content is now "party swatches +
  no-result" rather than "% verified" — frontend templates / docs
  that reference the old legend need updating.

## References

- `web/lib/party-colours.ts`
- `web/app/api/v1/parties/route.ts`
- `web/components/ResultsMap.tsx:regionFill`
- `db/migrations/0013_region_aggregates.sql` (produces
  `leader_party`)
- ADR-0012 (the reconciliation rules that ensure the polygon under
  a leader's colour is actually the right ward)
