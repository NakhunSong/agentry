/**
 * dependency-cruiser config — enforces ARCHITECTURE.md §6 layer rules.
 * core ← (testing | adapter-* | runtime); runtime ← apps; nothing else crosses.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-no-runtime-deps',
      severity: 'error',
      comment: 'packages/core must depend on nothing else in the workspace.',
      from: { path: '^packages/core/' },
      to: { path: '^(packages/(?!core/)|apps/)' },
    },
    {
      name: 'adapters-only-import-core',
      severity: 'error',
      comment: 'adapter-* may only import from core.',
      from: { path: '^packages/adapter-' },
      to: { path: '^(packages/(?!core/)|apps/)' },
    },
    {
      name: 'testing-only-imports-core',
      severity: 'error',
      comment: 'testing may only import from core.',
      from: { path: '^packages/testing/' },
      to: { path: '^(packages/(?!core/|testing/)|apps/)' },
    },
    {
      name: 'runtime-no-app-deps',
      severity: 'error',
      comment: 'runtime may not import from apps.',
      from: { path: '^packages/runtime/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-only-from-runtime',
      severity: 'error',
      comment: 'apps may only import from runtime (which re-exports core where needed).',
      from: { path: '^apps/' },
      to: { path: '^packages/(?!runtime/)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'No circular dependencies across the workspace.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphan modules indicate dead code or test-fixture leakage.',
      from: { orphan: true, pathNot: '\\.(test|spec)\\.[tj]s$|vitest\\.workspace\\.ts$' },
      to: {},
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node'],
      mainFields: ['types', 'main'],
    },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist(/|$)|(^|/)node_modules(/|$)' },
  },
};
