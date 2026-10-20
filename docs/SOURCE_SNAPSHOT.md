# About this source snapshot

This repository is a curated publication of Sifter's earlier development, with
fresh Git history created in October 2026. The original work dates from August
2025 to January 2026. The public history records publication work, not the original
development timeline.

## Included

- The React web app and Manifest V3 extension, including their original interfaces.
- Shared extraction, API client, type definitions and UI package.
- The Fastify API, search orchestration, matching, database schema and embedding worker.
- Gemini and SigLIP serving implementations, LoRA configuration, and caption preparation code.
- Existing tests and synthetic extraction fixtures.
- The case study, video link and thumbnail.

## Excluded

The original Git history, credentials, deployment configuration, account/project
identifiers, scraper and proxy tooling, operational scripts, database contents,
catalogue exports, seller records, standalone product photos, training/evaluation
datasets, model weights/tokenizer binary, notebooks, logs and raw video are not
distributed here. The video and thumbnail show product imagery as part of the
application demonstration; they are not a reusable clothing dataset.

This means a clone does not reproduce the recorded demo by itself. Running search
requires your own catalogue, model artifacts and service credentials.

## Changes after the original development period

The October 2026 local demonstration added infrastructure and sample data outside
this snapshot, corrected SigLIP text padding, preserved selected-item context for
the explicit More like this action, and excluded its reference item from results.
Retrieval weights and thresholds were not changed for the demonstration.

For publication, credentials and retired endpoints were removed. Service defaults
were changed to localhost, account features were made optional unless configured,
Redis connection-string logging was removed, and commands/dependencies for excluded
tools were removed. A separate unit-test configuration avoids the historical suite's
database setup hook.

These are publication and restoration changes, not claims about the original
production implementation.

## Limits

This is archived application source for review and experimentation. It is not
maintained or hardened for public deployment: the API lacks application-level
authentication, retains permissive CORS and debugging routes, and the extension
can send detected product information to its configured backend. The interfaces
also contain location lookup code. Review these behaviours before running it
against real users or exposing it outside your machine.

The historical backend type-check and test suites have known failures; the
[verification report](VERIFICATION.md) records the actual publication checks.
Successful frontend builds do not establish end-to-end readiness.

The retained [Apache-2.0 license](../LICENSE) applies to the source as provided.
Third-party dependencies and model assets retain their own licenses; retail and
resale imagery shown in the demonstration belongs to its respective owners.
