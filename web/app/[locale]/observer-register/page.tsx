import { unstable_setRequestLocale } from 'next-intl/server';

import { ObserverRegistrationForm } from '@/components/ObserverRegistrationForm';

export default function ObserverRegisterPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="max-w-2xl mx-auto px-6 py-10">
      <h1 className="text-2xl font-bold">Observer registration</h1>
      <p className="text-slate-600 mt-2">
        Accredited election observers - domestic or international - register here. Submissions
        are reviewed by the consortium governance committee. On approval, the named observer
        receives an OTP login link and can submit EC8As for any polling unit they cover.
      </p>
      <div className="mt-8">
        <ObserverRegistrationForm />
      </div>
    </div>
  );
}
