/**
 * @uride/config — shared Tailwind preset.
 *
 * Consumes @uride/ui-tokens as the single source of truth for design tokens.
 * Both web (Tailwind) and mobile (NativeWind) configs extend this preset so
 * a color/spacing change propagates everywhere.
 */
const tokens = require('@uride/ui-tokens/tailwind');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: tokens.colors,
      spacing: tokens.spacing,
      borderRadius: tokens.radius,
      fontFamily: tokens.fontFamily,
      fontSize: tokens.fontSize,
      boxShadow: tokens.elevation,
      transitionDuration: tokens.motion.duration,
      transitionTimingFunction: tokens.motion.easing,
    },
  },
  plugins: [],
};
