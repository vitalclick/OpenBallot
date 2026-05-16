import { unstable_setRequestLocale } from 'next-intl/server';

import { AgentFlow } from '@/components/agent/AgentFlow';

// The four-screen agent PWA. This is the only screen flow most agents
// will ever see on election day. Optimised for one-handed use, large hit
// targets, and zero typing.
export default function AgentPage({ params }: { params: { locale: string } }) {
  unstable_setRequestLocale(params.locale);
  return (
    <div className="min-h-[calc(100vh-64px)] bg-white">
      <AgentFlow />
    </div>
  );
}
