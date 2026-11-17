# Chalk compatibility warning reproduction

Captured on 2026-11-17 with Node.js 22.23.2 and npm 10.9.8.
The manifest matches the owner's three exact dependency versions.
The lockfile was generated with `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.
Target metadata comes from https://registry.npmjs.org/chalk/latest, which returned 6.0.1.

The real `analyzeCompatibility` ran against `buildDependencyGraph` and the
real `IsolatedResolverVerifier`, using this manifest and lockfile.
The resolver used npm's script-free dry run in an isolated temporary project.
`resolver-verification.json` records its result for deterministic offline tests.

Result: status `warning`, completeness `complete`, exactly one finding:
`["major-version-change","chalk","4.1.2","6.0.1"]`, status `warning`.
There were no peer findings. npm resolution succeeded with code `RESOLVED`.
Neither lodash nor is-number contributed a compatibility finding.

The warning is a reason to check a major update, not a confirmed project failure.
Chalk's module format and Node requirements belong to project checks.
The regression test parses these files and runs the real core analyzer with
the captured target metadata and resolver result. It does not access the network.
