import type { Metadata } from 'next';
import { unstable_setRequestLocale } from 'next-intl/server';

import { PollingUnitDetailView } from '@/components/PollingUnitDetail';

interface Props {
  params: { locale: string; code: string };
  searchParams: { election?: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const code = decodeURIComponent(params.code);
  return {
    title: `Polling Unit ${code} · OpenBallot Nigeria`,
    description: `Full submission history, signed EC8A images, anomaly flags, and the audit-chain entries for PU ${code}.`,
    openGraph: {
      title: `Polling Unit ${code}`,
      description:
        'Every submission, every signed EC8A, every anomaly, every audit-log event - cited by URL.',
      type: 'article',
    },
    twitter: {
      card: 'summary_large_image',
      title: `Polling Unit ${code}`,
    },
  };
}

export default function PUDetailPage({ params, searchParams }: Props) {
  unstable_setRequestLocale(params.locale);
  const electionId = searchParams.election ?? '2027-presidential';
  const code = decodeURIComponent(params.code);
  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <PollingUnitDetailView puCode={code} electionId={electionId} />
    </div>
  );
}
