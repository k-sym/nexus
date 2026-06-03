/** @type {import('tailwindcss').Config} */
// Warm reskin (issue #38): the neutral scale (`zinc`) is remapped from cold grey
// to a warm brown-black, and the accent (`indigo`) from blue-violet to burnt
// caramel. Every existing `bg-zinc-900` / `text-indigo-500` etc. picks these up
// automatically. Status colours (red/green/emerald/amber) are deliberately left
// as Tailwind defaults — they carry meaning and should stay as signal.
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Dark text that sits ON the caramel accent (--accent-fg).
        ink: '#2a1608',
        // Warm neutral ramp — surfaces are dark warm brown-black, text is warm-tinted grey.
        zinc: {
          50: '#faf6f2',
          100: '#f1eae3', // brightest text
          200: '#e8ddd2', // --text (primary)
          300: '#cdbcad',
          400: '#b39a86', // --text-dim (secondary)
          500: '#8f7c6c', // muted labels / meta
          600: '#6d5c4e', // --text-faint / dim icons
          700: '#46372d', // --border-hi (hover/emphasis borders)
          800: '#342a22', // --border (barely-there separation)
          900: '#241c17', // --surface (cards, sidebar, tiles, bubbles)
          950: '#17120f', // --bg (page background)
        },
        // Burnt-caramel accent ramp.
        indigo: {
          50: '#fbf1e8',
          100: '#f6ddc6',
          200: '#f0c9a8', // light text on accent tints (e.g. answered question picks)
          300: '#e3a877',
          400: '#d68f54', // lighter hover
          500: '#c8763c', // --accent
          600: '#ad6230', // darker hover
          700: '#8a4d26',
          800: '#673a1f',
          900: '#4a2a18',
        },
      },
    },
  },
  plugins: [],
};
