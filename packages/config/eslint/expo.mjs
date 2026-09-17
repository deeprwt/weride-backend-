// @ts-check
import react from './react.mjs';

export default [
  ...react,
  {
    languageOptions: {
      globals: {
        __DEV__: 'readonly',
      },
    },
    rules: {
      // RN-specific tweaks live here as we discover needs.
    },
  },
];
