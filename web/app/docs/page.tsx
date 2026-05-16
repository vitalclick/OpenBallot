export const metadata = {
  title: 'Public API · OpenBallot Nigeria',
  description:
    'Public REST API for OpenBallot Nigeria: election rollups, polling-unit detail, discrepancies, anomalies, audit hashes and Mapbox vector tiles.',
};

export default function DocsPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12 text-slate-700">
      <h1 className="text-3xl font-bold text-slate-900">Public API</h1>
      <p className="mt-3 max-w-2xl">
        Every figure published on OpenBallot is also available as machine-readable JSON or CSV.
        The API is unauthenticated, rate-limited per IP, and stable under semantic versioning.
        Mirrors and re-publication are explicitly permitted under AGPL-3.0.
      </p>

      <Section title="Conventions">
        <ul className="list-disc list-inside space-y-1 text-sm">
          <li>Base URL: <Code>https://openballot.ng/api/v1</Code></li>
          <li>All successful responses return <Code>{`{ data: ... }`}</Code> with HTTP 200.</li>
          <li>Election identifiers follow <Code>{`{year}-{office}`}</Code> (e.g. <Code>2027-presidential</Code>).</li>
          <li>Polling-unit codes are INEC&apos;s canonical <Code>SS-LL-WW-PPP</Code> format.</li>
          <li>Timestamps are ISO-8601 UTC.</li>
        </ul>
      </Section>

      <Section title="Elections">
        <Endpoint
          method="GET"
          path="/elections"
          desc="List every election OpenBallot is tracking."
          example="/api/v1/elections"
        />
        <Endpoint
          method="GET"
          path="/elections/{id}/results"
          desc="National rollup: votes per party, turnout, last_updated."
          example="/api/v1/elections/2027-presidential/results"
        />
        <Endpoint
          method="GET"
          path="/elections/{id}/results.csv"
          desc="Full per-PU × candidate results as CSV. One row per polling unit per candidate. Streams up to the entire national dataset."
          example="/api/v1/elections/2027-presidential/results.csv"
        />
        <Endpoint
          method="GET"
          path="/elections/{id}/units"
          desc="Live per-polling-unit verification state. Query with ?state=LA or ?pu=25-11-04-007."
          example="/api/v1/elections/2027-presidential/units?state=LA"
        />
        <Endpoint
          method="GET"
          path="/elections/{id}/dashboard"
          desc="Aggregate counters powering the home page LiveCounters."
          example="/api/v1/elections/2027-presidential/dashboard"
        />
        <Endpoint
          method="GET"
          path="/elections/{id}/stream"
          desc="Server-Sent Events feed of new submissions and consensus updates."
          example="/api/v1/elections/2027-presidential/stream"
        />
      </Section>

      <Section title="Polling units">
        <Endpoint
          method="GET"
          path="/polling-units/{code}/detail"
          desc="Consolidated PU view: header, every submission with extracted figures and image URL/SHA-256, anomalies, and recent audit-log events."
          example="/api/v1/polling-units/25-11-04-007/detail"
        />
        <Endpoint
          method="GET"
          path="/polling-units/{code}/submissions"
          desc="Just the per-source submissions for a polling unit."
          example="/api/v1/polling-units/25-11-04-007/submissions"
        />
      </Section>

      <Section title="Registers">
        <Endpoint
          method="GET"
          path="/discrepancies"
          desc="Cross-source disagreement register. ?election_id=… to scope."
          example="/api/v1/discrepancies?election_id=2027-presidential"
        />
        <Endpoint
          method="GET"
          path="/anomalies"
          desc="Statistical anomalies (over-voting, vote-share spikes, etc). Filter with ?state=LA&type=over_voting&min_severity=2."
          example="/api/v1/anomalies?min_severity=2"
        />
      </Section>

      <Section title="Audit">
        <Endpoint
          method="GET"
          path="/audit/hashes"
          desc="Downloadable CSV manifest of every submission's SHA-256 image hash. The Hash manifest link in the footer points here."
          example="/api/v1/audit/hashes?election_id=2027-presidential"
        />
        <Endpoint
          method="GET"
          path="/audit/verify"
          desc="Latest anchored Merkle root and instructions to re-derive it from the manifest."
          example="/api/v1/audit/verify"
        />
        <Endpoint
          method="GET"
          path="/health"
          desc="Liveness probe. Returns {status, version, timestamp}."
          example="/api/v1/health"
        />
      </Section>

      <Section title="Map tiles">
        <Endpoint
          method="GET"
          path="/tiles/{election}/{z}/{x}/{y}"
          desc="Mapbox-compatible vector tiles (MVT) shaded by consensus state. Wire directly into Mapbox GL JS or MapLibre."
          example="/api/v1/tiles/2027-presidential/6/32/30"
        />
      </Section>

      <Section title="Rate limits, mirrors and licence">
        <p className="text-sm">
          Public endpoints are capped at 60 requests / minute / IP. For bulk research access,
          mirror the nightly dataset dumps published under <Code>/datasets/</Code>. All
          OpenBallot data is released under{' '}
          <a
            className="text-blue-700 hover:underline"
            href="https://creativecommons.org/licenses/by/4.0/"
          >
            CC BY 4.0
          </a>{' '}
          and the source code under AGPL-3.0. Citation:{' '}
          <em>OpenBallot Consortium, openballot.ng, accessed YYYY-MM-DD.</em>
        </p>
      </Section>

      <p className="mt-12 text-xs text-slate-500">
        Issues, schema questions, or breaking-change notices belong on{' '}
        <a
          className="text-blue-700 hover:underline"
          href="https://github.com/vitalclick/openballot/issues"
        >
          GitHub
        </a>
        .
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Endpoint({
  method,
  path,
  desc,
  example,
}: {
  method: string;
  path: string;
  desc: string;
  example: string;
}) {
  return (
    <div className="border rounded-md p-4 bg-white">
      <div className="flex items-center gap-2 font-mono text-sm">
        <span className="px-2 py-0.5 rounded bg-ng-green text-white text-xs font-semibold">
          {method}
        </span>
        <span className="text-slate-900">{path}</span>
      </div>
      <p className="mt-2 text-sm">{desc}</p>
      <a
        href={example}
        className="mt-2 inline-block font-mono text-xs text-blue-700 hover:underline break-all"
      >
        {example}
      </a>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 text-[0.85em] font-mono">
      {children}
    </code>
  );
}
