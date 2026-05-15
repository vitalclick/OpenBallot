'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';

import { locales, type Locale } from '@/lib/i18n';

export function Header({ locale }: { locale: Locale }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const rest = pathname.replace(/^\/[a-z]{2,3}/, '') || '/';

  return (
    <header className="h-16 border-b bg-white sticky top-0 z-50">
      <div className="max-w-7xl mx-auto h-full px-6 flex items-center justify-between">
        <Link href={`/${locale}`} className="flex items-center gap-2">
          <span
            className="inline-block w-3 h-6 bg-ng-green rounded-sm"
            aria-hidden
          />
          <span className="font-bold tracking-tight">OpenBallot</span>
          <span className="text-slate-500 hidden sm:inline">Nigeria</span>
        </Link>

        <nav className="flex items-center gap-1 sm:gap-4 text-sm">
          <Link href={`/${locale}/map`} className="px-2 py-1 hover:underline">
            {t('map')}
          </Link>
          <Link href={`/${locale}/discrepancies`} className="px-2 py-1 hover:underline">
            {t('discrepancies')}
          </Link>
          <Link href={`/${locale}/anomalies`} className="px-2 py-1 hover:underline">
            {t('anomalies')}
          </Link>
          <Link href={`/${locale}/agent`} className="px-2 py-1 hover:underline hidden sm:inline">
            {t('agent')}
          </Link>
          <Link href={`/${locale}/admin`} className="px-2 py-1 hover:underline hidden sm:inline">
            {t('admin')}
          </Link>

          <select
            aria-label="Language"
            className="ml-2 border rounded px-2 py-1 text-xs bg-white"
            value={locale}
            onChange={(e) => {
              window.location.href = `/${e.target.value}${rest}`;
            }}
          >
            {locales.map((l) => (
              <option key={l} value={l}>
                {l.toUpperCase()}
              </option>
            ))}
          </select>
        </nav>
      </div>
    </header>
  );
}
