import { BRAND } from '@/lib/brand';
import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import './globals.css';
import './additions.css';
import './product.css';

// NEXT_PUBLIC_SITE_URL is public and non-secret. The localhost fallback exists for development only.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.NODE_ENV === 'production' ? `https://${BRAND.repoSlug}.invalid` : 'http://localhost:3000');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  robots: { index: true, follow: true },
  icons: {
    icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  manifest: '/site.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#ffffff',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Render dynamically so the per-request CSP nonce (src/proxy.ts) can be applied to Next's own scripts.
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
