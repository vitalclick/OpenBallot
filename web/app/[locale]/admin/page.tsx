import { unstable_setRequestLocale } from 'next-intl/server';

import { AdminDashboard } from '@/components/admin/AdminDashboard';

export default function AdminPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-bold">Party Admin Portal</h1>
      <p className="text-slate-600 mt-1">
        Roster management, agent onboarding, and per-PU submission status.
      </p>
      <AdminDashboard />
    </div>
  );
}
