import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

/**
 * Flat ESLint config for the React + Vite frontend. Kept close to the recommended sets
 * so it complements (does not fight) the strict `tsc --noEmit` gate the build already
 * runs. The `react-hooks` plugin makes deliberate hook-dep suppressions explicit.
 */
export default tseslint.config(
  { ignores: ['dist', 'mcp', 'docs', 'node_modules', '.vercel'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // The rules the two recommended sets gained with ESLint 10 and react-hooks 7. They are off so
      // that the upgrade changes no verdict: src/ keeps the rule set it was written against (0
      // errors, 10 react-refresh warnings). Each line says what the rule looks for and how many
      // places in src/ it reported on the day of the upgrade (2026-11-23). Turning one on is a
      // change of its own, with its own fixes.
      'no-unassigned-vars': 'off', // eslint:recommended since 10: a `let` or `var` read but never assigned. 0 reports.
      'no-useless-assignment': 'off', // eslint:recommended since 10: a value assigned and never used. 6 reports.
      'preserve-caught-error': 'off', // eslint:recommended since 10: a rethrow that drops the caught error (no `cause`). 8 reports.
      // The React Compiler's checks, in react-hooks' recommended set since 7.0.0. This build does not
      // run the compiler (vite.config.ts), so nothing depends on them holding yet.
      'react-hooks/config': 'off', // the compiler's options are valid. 0 reports: there are no options.
      'react-hooks/error-boundaries': 'off', // try/catch used where an error boundary is meant. 0 reports.
      'react-hooks/gating': 'off', // the compiler's gating mode is configured correctly. 0 reports: no gating.
      'react-hooks/globals': 'off', // a global assigned or mutated during render. 0 reports.
      'react-hooks/immutability': 'off', // props, state or another immutable value mutated. 1 report.
      'react-hooks/incompatible-library': 'off', // a library that cannot be memoized around (a warning). 0 reports.
      'react-hooks/preserve-manual-memoization': 'off', // a useMemo or useCallback the compiler could not keep. 0 reports.
      'react-hooks/purity': 'off', // a known-impure call, such as Date.now(), during render. 6 reports.
      'react-hooks/refs': 'off', // a ref read or written during render. 18 reports.
      'react-hooks/set-state-in-effect': 'off', // setState called synchronously in an effect. 88 reports.
      'react-hooks/set-state-in-render': 'off', // setState called during render. 0 reports.
      'react-hooks/static-components': 'off', // a component created inside another component's render. 2 reports.
      'react-hooks/unsupported-syntax': 'off', // syntax the compiler will not support (a warning). 0 reports.
      'react-hooks/use-memo': 'off', // a useMemo() call used the wrong way. 0 reports.
    },
  },
)
