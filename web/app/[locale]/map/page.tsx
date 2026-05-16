import 'mapbox-gl/dist/mapbox-gl.css';

import { unstable_setRequestLocale } from 'next-intl/server';

import { ResultsMap } from '@/components/ResultsMap';

export const metadata = {
  title: 'Result Verification · OpenBallot Nigeria',
};

export default function MapPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="flex flex-col h-[calc(100vh-64px)] bg-slate-50">
      <header className="border-b bg-white">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <h1 className="text-lg font-semibold text-slate-800">Result Verification</h1>
          <p className="text-xs text-slate-500 max-w-3xl">
            Each polling unit on the map shows the verification state of its EC8A form.
            Use this view to investigate where independent sources agree, where they
            disagree, and where INEC&apos;s published figure conflicts with the consensus.
            For headline totals, see the{' '}
            <a href="/en/results" className="underline hover:no-underline">Results Dashboard</a>.
          </p>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        <ResultsMap electionId="2027-presidential" />
      </div>
    </div>
  );
}
