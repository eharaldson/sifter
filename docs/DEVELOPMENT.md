# Inspecting and building the source

This is a source snapshot, not a packaged demo. See [scope and exclusions](SOURCE_SNAPSHOT.md)
and [verification results](VERIFICATION.md) before attempting to run services.

## Frontend builds

Use Node.js 22.12 or later and pnpm 10.15.1. From the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:packages
pnpm web:build
pnpm extension:build
pnpm check:publication
```

The install deliberately skips dependency lifecycle scripts. The web build is in
`apps/web/dist`; the unpacked extension is in `apps/extension/dist`. Neither is
committed. The extension and SDK default to `http://localhost:3001/api`.

For the web development server, copy `apps/web/.env.example` to `apps/web/.env`
and run `pnpm web:dev`. Account features are disabled without your own Supabase
URL and public anon key. The shopping interface still loads, but search needs
the backend and populated catalogue.

The extension reads its API URL from the build process environment:

```sh
VITE_API_URL=http://localhost:3001/api pnpm extension:build
```

If using another host, update the manifest's host permissions accordingly.

## Backend and models

- Copy `apps/backend/.env.example` to `apps/backend/.env` and configure your own
  PostgreSQL instance with pgvector and pg_trgm, Redis, and OpenAI credentials.
  The schema and migration entry points are in `apps/backend/src`.
- The Gemini service needs its Python requirements and an exported
  `GEMINI_API_KEY`; use its `.env.example` as a reference.
- The SigLIP service needs its Python requirements and a complete compatible
  LoRA/processor artifact directory. Only configuration is included here.
  Supply the adapter weights and tokenizer assets yourself; the original
  fine-tuned model is not distributed in this snapshot.
- Ingest your own authorized catalogue through the product-resolution API and
  generate its embeddings. The video's database and scraping tools are excluded.
- Run the API from its package directory with `pnpm --filter backend start`.
  The retained runtime uses `tsx`; this does not imply a clean TypeScript build.

Do not expose these archived services directly to the internet. This snapshot
has not been validated as a complete fresh deployment.

## Tests and publication checks

```sh
pnpm --filter backend test:unit
pnpm --filter backend exec tsc --noEmit
pnpm --filter extension test
python3 scripts/check_publication.py
```

The backend unit command runs the existing normalization and colour-matching tests
without connecting to a database. The remaining backend integration suite needs
an isolated test database and service configuration and was not run for publication.
See the verification report for known failures rather than assuming these commands
all pass.

For a separate secret scan, install Gitleaks from its official distribution and run:

```sh
gitleaks dir . --redact
gitleaks git . --redact
```

Run scans on a clean checkout so generated dependency/build files do not obscure
the source review. Never upload local environment files or runtime data.
