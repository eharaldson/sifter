# Publication verification

Checked on 20 October 2026 on macOS / Apple Silicon using Node.js 26.3.1,
pnpm 10.15.1, TypeScript 5.9.2 and Gitleaks 8.30.1.

## Publication checks

The copy was assembled from an explicit file selection, not by copying the
development folder or its Git history. All credentials, original service
endpoints, environment files, database contents, model weights and operational
artifacts identified during preparation were excluded or removed.

- Gitleaks filesystem and new-history scans: **no findings**.
- Exact matching against credential and connection values in the original local
  configuration: **no matches**. Values were not written into this repository.
- Publication guard: checks forbidden file types, credential patterns, retired
  service domains, personal filesystem paths, file sizes and local Markdown links.
- Fresh-clone review: source and new Git history only; no development history,
  dependency directories, build outputs or secret configuration included.
- The initial commit uses the owner's GitHub noreply identity.

Scanning is evidence about this snapshot, not a guarantee that all possible
secrets are detectable. It also does not revoke credentials previously stored
in the private development repository.

## Build and test results

| Check | Result |
| --- | --- |
| Locked dependency install, lifecycle scripts disabled | Passed |
| Four shared package builds | Passed |
| Web production build | Passed |
| Chrome extension production build | Passed |
| Included Python source syntax | Passed |
| Backend unit tests: normalization and colour matching | 22 passed, 6 failed |
| Backend TypeScript check | Failed: 14 diagnostics |
| Extension tests | 8 passed, 7 failed; 2 additional suites could not load |
| Backend integration tests / full search deployment | Not run |

The backend unit failures are in the original normalization expectations; the
colour-matching test file passes. The normalization and matching implementations
and their tests are unchanged from the development repository.

Backend type errors include undeclared `abort-controller`/`uuid` dependencies,
legacy TypeScript module resolution for LangChain exports, stale references and
test types. Extension failures include old detection/logging expectations and
two test files importing modules absent from the original source tree. These
failures have not been hidden by deleting tests or changing their assertions.

The frontend builds also emit dependency warnings about older browser data and
ignored React `"use client"` directives. The dependency install reports an
existing OpenAI peer-version mismatch in a transitive package.

This snapshot is suitable for publishing as an **archived source case study**.
It is not certified as production-ready, fully reproducible, or passing the
complete historical test suite. No end-to-end, dependency vulnerability, or
internet-facing security audit is claimed.
