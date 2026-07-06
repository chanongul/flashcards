/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  // Compile every `hover:` utility under `@media (hover: hover)` so hover
  // styles only apply on devices with a real pointer (desktop) — on touch
  // devices they'd otherwise "stick" after a tap until you tap elsewhere.
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      fontFamily: {
        // App-wide font stack. Font fallback is per-character: Latin renders
        // in Geist Mono; Thai (absent from Geist Mono) falls through to
        // Sukhumvit Set; anything else (e.g. CJK) hits the system fonts. Both
        // variables are provided by next/font in app/layout.tsx.
        sans: [
          'var(--font-geist-mono)',
          'var(--font-sukhumvit)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
      colors: {
        // Olive green for the "due" status — not in Tailwind's default palette.
        // 300 = light olive for text on the near-black bg; 900 = dark olive
        // for the card-state badge background (used at /50 like the others).
        olive: {
          300: '#b7c46a',
          900: '#3f471c',
        },
      },
    },
  },
  plugins: [],
};
