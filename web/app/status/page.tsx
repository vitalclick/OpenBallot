import { StatusBoard } from '@/components/StatusBoard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata = {
  title: 'Status · OpenBallot Nigeria',
  description: 'Real-time operational status: API + worker health, queue depth, last audit anchor.',
};

export default function StatusPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold">System status</h1>
      <p className="mt-2 text-slate-600 max-w-2xl">
        Live operational signals for the OpenBallot Nigeria platform. Each card refreshes every
        30 seconds. For incident history see the public post-mortems in the GitHub repo.
      </p>
      <div className="mt-8">
        <StatusBoard />
      </div>
      <p className="mt-12 text-xs text-slate-500">
        Verify the audit chain yourself at{' '}
        <a className="text-blue-700 hover:underline" href="/api/v1/audit/verify">
          /api/v1/audit/verify
        </a>{' '}
        or download the full hash manifest at{' '}
        <a className="text-blue-700 hover:underline" href="/api/v1/audit/hashes">
          /api/v1/audit/hashes
        </a>
        .
      </p>
    </div>
  );
}
