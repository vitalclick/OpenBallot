# ADR-0009: AGPL-3.0 licence

- **Status**: Accepted
- **Date**: 2026-01-15
- **Deciders**: Founding consortium

## Context

The platform's value proposition is transparency. A licence that
permits a closed-source fork would let a future political actor
deploy a version of OpenBallot that omits the audit chain or the
anomaly detection while still calling it OpenBallot. We need a
licence that legally binds any redeployment to remain open.

## Decision

**OpenBallot Nigeria is licensed under AGPL-3.0-or-later.**

The AGPL's distinctive clause — that running modified source as a
network service requires releasing the modified source under the
same licence — is the exact property we need. Any party, government,
or commercial entity that deploys a fork of OpenBallot must keep
their fork open.

## Alternatives considered

- **MIT / Apache 2.0**: rejected. Permits closed-source forks of the
  exact thing the project's value depends on.
- **GPL v3**: rejected. The GPL's reciprocity only triggers on
  distribution. A web service that runs modified GPL code without
  distributing the binaries to end users has no GPL obligation.
- **Source-available with commercial clause (BSL / SSPL)**: rejected.
  Excludes commercial deployers we actually want — local news
  organisations, partner CSOs running mirrors.
- **Custom licence**: rejected. Custom licences are hard for legal
  teams to clear; standard licences are well-understood.

## Consequences

**Easy**: any redeployment is legally required to be open. A
political actor cannot quietly close-source a fork.

**Hard**: AGPL is incompatible with proprietary software linking.
Any future commercial partner that wants to embed OpenBallot inside
a proprietary product would need to either (a) keep their wrapper
open or (b) negotiate a separate licence with the consortium. The
consortium has not committed to either path.

**Locked-in**: relicensing requires consent from every contributor.
A Contributor Licence Agreement (CLA) is in the contributor workflow
(see CONTRIBUTING.md) so the consortium has the option to
sub-license in future if a clear public-interest case arises.

## References

- `LICENSE` (root)
- `CONTRIBUTING.md` (root)
- README § Licence
