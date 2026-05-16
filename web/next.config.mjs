import createNextIntlPlugin from 'next-intl/plugin';
import withPWAInit from 'next-pwa';

const withNextIntl = createNextIntlPlugin('./lib/i18n.ts');

const withPWA = withPWAInit({
  dest: 'public',
  // Offline-first agent flow. The PWA must work without connectivity from
  // the moment the camera screen loads through the eventual upload.
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === 'development',
  // Custom worker that handles Background Sync. next-pwa appends the
  // contents of sw-custom/index.js to the generated service worker so
  // we get Workbox's caching plus our drainer in one SW.
  customWorkerDir: 'sw-custom',
  runtimeCaching: [
    {
      urlPattern: /^https?:\/\/.*\/api\/v1\/elections\/.*\/results.*/i,
      handler: 'NetworkFirst',
      options: { cacheName: 'api-results', expiration: { maxEntries: 200, maxAgeSeconds: 60 } },
    },
    {
      urlPattern: /\/_next\/image\?.*/i,
      handler: 'StaleWhileRevalidate',
      options: { cacheName: 'next-image' },
    },
    {
      urlPattern: /^https?:\/\/api\.mapbox\.com\/.*/i,
      handler: 'StaleWhileRevalidate',
      options: { cacheName: 'mapbox-tiles', expiration: { maxAgeSeconds: 60 * 60 * 24 * 7 } },
    },
  ],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // typedRoutes is experimental and makes <Link href> reject plain
  // string props, which breaks helper components that pass dynamically-
  // chosen routes (e.g. the landing page's Audience cards). Switching
  // off until either the prop API stabilises or we adopt the Route<>
  // type everywhere.
  // experimental: { typedRoutes: true },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), geolocation=(self), microphone=()',
          },
        ],
      },
      {
        // Embed widget needs to be iframeable
        source: '/embed/(.*)',
        headers: [{ key: 'X-Frame-Options', value: 'ALLOWALL' }],
      },
    ];
  },
};

export default withNextIntl(withPWA(nextConfig));
