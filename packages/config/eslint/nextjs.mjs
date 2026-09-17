// @ts-check
import react from './react.mjs';

// Next.js plugin uses legacy eslint config style; consumers should extend
// `eslint-config-next` via FlatCompat in their own eslint.config.mjs.
// This preset provides the React baseline; Next-specific rules are added
// per-app via FlatCompat to avoid pulling Next as a hard dep here.
export default react;
