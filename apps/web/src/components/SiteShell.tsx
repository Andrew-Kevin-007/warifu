import type { ReactNode } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

export default function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="global-wrapper relative flex min-h-screen flex-col justify-between overflow-hidden">
      <Header />
      {children}
      <Footer />
    </div>
  );
}
