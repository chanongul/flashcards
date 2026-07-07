import type { Metadata, Viewport } from 'next';
import { Geist_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import { Smartphone } from 'lucide-react';
import './globals.css';
import { SyncManager } from '@/components/SyncManager';
import { LoadingProvider } from '@/components/GlobalLoading';

// Self-hosted at build time by next/font — no runtime Google request, so it
// still works offline in the installed PWA.
const geistMono = Geist_Mono({
  subsets: ['latin'],
  weight: 'variable',
  variable: '--font-geist-mono',
});

// Thai fallback: Geist Mono has no Thai glyphs, so the font stack falls
// through to Sukhumvit Set for Thai characters only — Latin text never
// reaches it. Only the weights the app actually uses (400/500/600/700).
const sukhumvit = localFont({
  src: [
    { path: './fonts/SukhumvitSet-Text.ttf', weight: '400', style: 'normal' },
    { path: './fonts/SukhumvitSet-Medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/SukhumvitSet-SemiBold.ttf', weight: '600', style: 'normal' },
    { path: './fonts/SukhumvitSet-Bold.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-sukhumvit',
});

export const metadata: Metadata = {
  title: 'Flashcards',
  description: 'A spaced-repetition flashcard app',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Flashcards',
  },
  icons: {
    icon: '/favicon-32.png',
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistMono.variable} ${sukhumvit.variable}`}>
      <body>
        <LoadingProvider>
          <SyncManager />
          {children}
        </LoadingProvider>
        {/* See globals.css's .landscape-lock rule — hidden by default,
            shown only on phones/tablets (coarse pointer) in landscape. */}
        <div className="landscape-lock fixed inset-0 z-[200] flex-col items-center justify-center gap-3 bg-neutral-950 p-6 text-center text-neutral-100">
          <Smartphone size={40} className="rotate-90" />
          <p className="text-sm text-neutral-400">Rotate your device back to portrait to use Flashcards.</p>
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js');
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}
