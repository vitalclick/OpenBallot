'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { locales, type Locale } from '@/lib/i18n';

export function Header({ locale }: { locale: Locale }) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const rest = pathname.replace(/^\/[a-z]{2,3}/, '') || '/';
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const navLinks: Array<{ href: string; label: string }> = [
    { href: `/${locale}/results`, label: t('results') },
    { href: `/${locale}/results-2023`, label: t('results2023') },
    { href: `/${locale}/map`, label: t('map') },
    { href: `/${locale}/discrepancies`, label: t('discrepancies') },
    { href: `/${locale}/anomalies`, label: t('anomalies') },
    { href: `/${locale}/agent`, label: t('agent') },
    { href: `/${locale}/observer-register`, label: t('observer') },
    { href: `/${locale}/admin`, label: t('admin') },
  ];

  const localeSelect = (
    <select
      aria-label="Language"
      className="border rounded px-2 py-1 text-xs bg-white"
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
  );

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

        <nav className="hidden md:flex items-center gap-4 text-sm">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="px-2 py-1 hover:underline">
              {link.label}
            </Link>
          ))}
          <div className="ml-2">{localeSelect}</div>
        </nav>

        <div className="flex items-center gap-2 md:hidden">
          {localeSelect}
          <button
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex items-center justify-center w-10 h-10 rounded border hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-ng-green"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {menuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div
          className="md:hidden fixed inset-0 top-16 bg-black/30 z-40"
          onClick={() => setMenuOpen(false)}
          aria-hidden
        />
      )}

      <nav
        id="mobile-nav"
        className={`md:hidden absolute left-0 right-0 top-16 bg-white border-b shadow-lg z-50 transition-transform origin-top ${
          menuOpen ? 'block' : 'hidden'
        }`}
        aria-label="Mobile navigation"
      >
        <ul className="flex flex-col py-2">
          {navLinks.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="block px-6 py-3 text-base hover:bg-slate-50 border-b last:border-b-0"
                onClick={() => setMenuOpen(false)}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
