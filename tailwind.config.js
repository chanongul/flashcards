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
