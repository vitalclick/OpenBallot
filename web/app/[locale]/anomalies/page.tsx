import { unstable_setRequestLocale } from 'next-intl/server';

import { AnomalyRegister } from '@/components/AnomalyRegister';

export default function AnomaliesPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold">Anomaly Register</h1>
      <p className="text-slate-600 mt-1 max-w-3xl">
        Polling units where the data is internally inconsistent (votes exceed registered,
        turnout exceeds accreditation) or where it is an extreme statistical outlier against
        ward / LGA peers or against the 2023 baseline. Anomalies are independent of the
        discrepancy register — a unit may be flagged here even when all submissions agree.
      </p>
      <div className="mt-6">
        <AnomalyRegister electionId="2027-presidential" />
      </div>
    </div>
  );
}
