import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Verification status colour scale - shared with the map renderer
        status: {
          nodata: '#e5e7eb',
          single: '#f6c453',
          inec_published: '#64748b',
          consensus: '#22c55e',
          discrepancy: '#f97316',
          confirmed: '#2563eb',
          conflict: '#dc2626',
        },
        ng: {
          // Official Nigerian flag green and a coordinated scale used by
          // the public dashboard. The 600 step is the flag colour.
          50:  '#e6f4ec',
          100: '#cfe9da',
          200: '#a1d4b6',
          300: '#73bf91',
          400: '#3ea76c',
          500: '#179656',
          600: '#008753',
          700: '#006a40',
          800: '#004f30',
          900: '#003520',
          green:     '#008753',
          greenDark: '#006a40',
          mint:      '#e6f4ec',
          white:     '#ffffff',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
