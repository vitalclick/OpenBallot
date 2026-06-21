import { Suspense } from 'react';
import { unstable_setRequestLocale } from 'next-intl/server';

import { OfficialResults2023 } from '@/components/OfficialResults2023';

export const metadata = {
  title: '2023 Official Results · OpenBallot Nigeria',
  description:
    'Official 2023 General Election results as published by INEC: presidential national tally, declared winners for 1,490 legislative and governorship seats, and state registration.',
};

// Dedicated, self-contained page for the INEC-published 2023 results
// (extracted from the General Election Report PDF). Deliberately separate
// from the live per-polling-unit verification surface (/results, /map) so the
// two data layers — official baseline vs. crowd/IReV evidence — never blur,
// and the IReV pipeline can evolve independently.
export default function Results2023Page({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="bg-slate-50 min-h-screen">
      <div className="border-b bg-white">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <h1 className="text-lg font-semibold text-slate-800">2023 General Election — Official Results</h1>
          <p className="text-xs text-slate-500">
            As published by INEC in the <em>Report of the 2023 General Election</em> (Feb 2024)
          </p>
        </div>
      </div>
      <Suspense fallback={<div className="p-10 text-slate-500">Loading official results…</div>}>
        <OfficialResults2023 />
      </Suspense>
    </div>
  );
}
