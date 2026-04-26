/**
 * dependency-cruiser config — enforces ARCHITECTURE.md §6 layer rules.
 * core ← (testing | adapter-* | runtime | apps); apps may also wire adapters
 * directly as the composition root (§7); testing is unit-test-only.
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
      comment: 'adapter-* may only import from core (or itself).',
      from: { path: '^packages/(adapter-[^/]+)/' },
      to: {
        path: '^(packages/|apps/)',
        pathNot: '^packages/(core|$1)/',
      },
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
      name: 'apps-no-testing',
      severity: 'error',
      comment:
        'apps act as the composition root (ARCHITECTURE.md §7): they may import core, runtime, and adapter-* directly. runtime is convenience, not a chokepoint — but never test-only utilities.',
      from: { path: '^apps/' },
      to: { path: '^packages/testing/' },
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
