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
    extend: {},
  },
  plugins: [],
};
