import { unstable_setRequestLocale } from 'next-intl/server';

import { DiscrepancyRegister } from '@/components/DiscrepancyRegister';

export default function DiscrepanciesPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold">Discrepancy Register</h1>
      <p className="text-slate-600 mt-1 max-w-3xl">
        Every polling unit where independent submissions disagree, or where INEC&apos;s upload
        conflicts with multi-source consensus. Updated in real time during active elections.
      </p>
      <div className="mt-6">
        <DiscrepancyRegister electionId="2027-presidential" />
      </div>
    </div>
  );
}
