import { unstable_setRequestLocale } from 'next-intl/server';

import { ResultsDashboard } from '@/components/ResultsDashboard';

export const metadata = {
  title: 'Results Dashboard · OpenBallot Nigeria',
};

export default function ResultsPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="bg-slate-50 min-h-screen">
      <div className="border-b bg-white">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <h1 className="text-lg font-semibold text-slate-800">Results Dashboard</h1>
          <p className="text-xs text-slate-500">National and State Elections</p>
        </div>
      </div>
      <ResultsDashboard electionId="2027-presidential" />
    </div>
  );
}
