import { useTranslations } from 'next-intl';
import Link from 'next/link';

import { LiveCounters } from '@/components/LiveCounters';

export default function LandingPage() {
  const t = useTranslations('landing');
  return (
    <div>
      {/* Hero band */}
      <div className="border-b bg-gradient-to-b from-white to-slate-50">
        <div className="max-w-6xl mx-auto px-6 py-16 md:py-20">
          <p className="text-sm uppercase tracking-widest text-ng-green font-semibold">
            {t('eyebrow')}
          </p>
          <h1 className="text-4xl md:text-6xl font-bold mt-3 leading-tight tracking-tight">
            {t('title')}
          </h1>
          <p className="mt-5 text-lg md:text-xl text-slate-700 max-w-3xl leading-relaxed">
            {t('lede')}
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/en/map"
              className="px-5 py-3 rounded-md bg-ng-green text-white font-medium hover:opacity-90"
            >
              {t('cta_map')}
            </Link>
            <Link
              href="/en/discrepancies"
              className="px-5 py-3 rounded-md border border-slate-300 hover:bg-slate-100"
            >
              {t('cta_disc')}
            </Link>
            <Link
              href="/en/anomalies"
              className="px-5 py-3 rounded-md border border-slate-300 hover:bg-slate-100"
            >
              {t('cta_anomalies')}
            </Link>
            <Link
              href="/en/agent"
              className="px-5 py-3 rounded-md border border-slate-300 hover:bg-slate-100"
            >
              {t('cta_agent')}
            </Link>
          </div>

          <div className="mt-12">
            <LiveCounters electionId="2027-presidential" />
          </div>
        </div>
      </div>

      {/* Three pillars */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h2 className="text-2xl md:text-3xl font-bold">{t('pillars_title')}</h2>
          <p className="text-slate-600 mt-2 max-w-2xl mx-auto">{t('pillars_lede')}</p>
        </div>
        <div className="grid md:grid-cols-3 gap-6">
          <Pillar
            badge="1"
            title={t('feature1_title')}
            body={t('feature1_body')}
            example={t('feature1_example')}
          />
          <Pillar
            badge="2"
            title={t('feature2_title')}
            body={t('feature2_body')}
            example={t('feature2_example')}
          />
          <Pillar
            badge="3"
            title={t('feature3_title')}
            body={t('feature3_body')}
            example={t('feature3_example')}
          />
        </div>
      </section>

      {/* How it works */}
      <section className="bg-slate-50 border-y">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-2xl md:text-3xl font-bold">{t('how_title')}</h2>
          <p className="text-slate-600 mt-2 max-w-2xl">{t('how_lede')}</p>
          <ol className="mt-8 space-y-6">
            <Step n={1} title={t('how_step1_title')} body={t('how_step1_body')} />
            <Step n={2} title={t('how_step2_title')} body={t('how_step2_body')} />
            <Step n={3} title={t('how_step3_title')} body={t('how_step3_body')} />
            <Step n={4} title={t('how_step4_title')} body={t('how_step4_body')} />
            <Step n={5} title={t('how_step5_title')} body={t('how_step5_body')} />
          </ol>
        </div>
      </section>

      {/* For each audience */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-2xl md:text-3xl font-bold">{t('audiences_title')}</h2>
        <div className="grid md:grid-cols-2 gap-6 mt-8">
          <Audience
            title={t('audience_journalist_title')}
            body={t('audience_journalist_body')}
            link={`/en/map`}
            linkText={t('audience_journalist_link')}
          />
          <Audience
            title={t('audience_party_title')}
            body={t('audience_party_body')}
            link={`/en/admin`}
            linkText={t('audience_party_link')}
          />
          <Audience
            title={t('audience_observer_title')}
            body={t('audience_observer_body')}
            link={`/en/observer-register`}
            linkText={t('audience_observer_link')}
          />
          <Audience
            title={t('audience_researcher_title')}
            body={t('audience_researcher_body')}
            link={`/api/v1/elections/2023-presidential/results.csv`}
            linkText={t('audience_researcher_link')}
          />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t bg-white">
        <div className="max-w-6xl mx-auto px-6 py-10 text-sm text-slate-600">
          <div className="grid md:grid-cols-4 gap-6">
            <div>
              <div className="font-semibold text-slate-900">OpenBallot Nigeria</div>
              <p className="mt-2">{t('footer_tagline')}</p>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{t('footer_explore')}</div>
              <ul className="mt-2 space-y-1">
                <li><Link href="/en/map" className="hover:underline">Map</Link></li>
                <li><Link href="/en/discrepancies" className="hover:underline">Discrepancies</Link></li>
                <li><Link href="/en/anomalies" className="hover:underline">Anomalies</Link></li>
                <li><Link href="/status" className="hover:underline">Status</Link></li>
              </ul>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{t('footer_participate')}</div>
              <ul className="mt-2 space-y-1">
                <li><Link href="/en/agent" className="hover:underline">Agent app</Link></li>
                <li><Link href="/en/observer-register" className="hover:underline">Register as observer</Link></li>
              </ul>
            </div>
            <div>
              <div className="font-semibold text-slate-900">{t('footer_developers')}</div>
              <ul className="mt-2 space-y-1">
                <li><a href="/docs" className="hover:underline">Public API</a></li>
                <li><a href="/api/v1/audit/hashes?election_id=2023-presidential" className="hover:underline">Hash manifest</a></li>
                <li>
                  <a href="https://github.com/vitalclick/Nigeria-Election-Results-Portal" className="hover:underline">
                    GitHub
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <p className="mt-8 text-xs text-slate-500">{t('footer_licence')}</p>
        </div>
      </footer>
    </div>
  );
}

function Pillar({
  badge,
  title,
  body,
  example,
}: {
  badge: string;
  title: string;
  body: string;
  example: string;
}) {
  return (
    <div className="p-6 border rounded-lg bg-white">
      <div className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-ng-green text-white font-bold text-sm">
        {badge}
      </div>
      <h3 className="font-semibold mt-3 text-lg">{title}</h3>
      <p className="mt-2 text-slate-600 text-sm">{body}</p>
      <p className="mt-3 text-xs text-slate-500 italic">{example}</p>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-4">
      <div className="flex-none w-8 h-8 rounded-full bg-white border-2 border-ng-green text-ng-green font-bold flex items-center justify-center text-sm">
        {n}
      </div>
      <div>
        <h3 className="font-semibold">{title}</h3>
        <p className="text-slate-600 text-sm mt-1">{body}</p>
      </div>
    </li>
  );
}

function Audience({
  title,
  body,
  link,
  linkText,
}: {
  title: string;
  body: string;
  link: string;
  linkText: string;
}) {
  return (
    <div className="p-6 border rounded-lg bg-white">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-slate-600 text-sm">{body}</p>
      <Link href={link} className="mt-3 inline-block text-ng-green hover:underline text-sm font-medium">
        {linkText} →
      </Link>
    </div>
  );
}
