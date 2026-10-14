import type { Metadata, Viewport } from 'next';
import './globals.css';
import './additions.css';

export const metadata: Metadata = {
  metadataBase: new URL('http://localhost:3000'),
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
