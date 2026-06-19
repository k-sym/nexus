# Trust and privacy surface for local services, secrets, and memory

## Goal

Make Nexus's actual trust boundaries visible in the README and in a read-only Settings section. A user should be able to determine where data and credentials live, which services run locally, what is sent to providers, and how Nexus memory behaves without reading the source.

## Product surface

Add a **Trust & Privacy** section at the bottom of the existing Settings page. It is informational and is loaded separately from the mutable settings form so derived runtime facts cannot be echoed into `config.yaml`.

The section shows:

- local services, effective ports/URLs, and whether each endpoint is loopback-only;
- the Nexus database, canonical Obsidian vault, disposable memory index, config, and Pi credential file paths;
- memory namespaces, auto-injection state and limits, and session archival behavior;
- each supported secret's configured source and detection state, never its value;
- configured remote provider destinations and the categories of content sent to them;
- the telemetry stance: Nexus contains no application analytics or telemetry integration, while configured model and issue providers receive the requests necessary to provide their service.

The section also contains two memory operations:

- **Rebuild index**: re-scan canonical Markdown and regenerate the disposable search/vector/knowledge-graph index without deleting vault files.
- **Clear Nexus memory**: permanently delete canonical memory files whose namespace is exactly `nexus`, then remove their derived index data. Memories in `global`, OpenClaw, or any other namespace, and unrelated files in the vault, are preserved. The action requires typing `CLEAR NEXUS MEMORY` and confirming again in the operation request.

Both actions show progress, disable conflicting controls while running, and render the returned counts or an inline error. They do not modify the auto-injection setting.

## Trust API

Add `GET /api/trust` to the Nexus backend. The response is a read-only snapshot with stable groups for services, storage, secrets, memory, outbound connections, and telemetry.

The backend derives the snapshot from effective configuration and runtime credential resolvers. It may return paths, ports, booleans, provider names, credential types, and source labels. It must never return raw environment values, API keys, OAuth access/refresh tokens, authorization headers, or the contents of `.env`, `config.yaml`, or `auth.json`.

Secret source labels reflect actual behavior:

- Pi provider API keys and OAuth credentials: `~/.nexus/auth.json`;
- OpenRouter, local-model, and assistant keys: environment interpolation or a masked literal in `config.yaml`;
- Jira: `JIRA_TOKEN` from the process environment or loaded local `.env`;
- GitHub: `GITHUB_TOKEN`, otherwise `gh auth token`, otherwise absent.

Detection uses boolean/status metadata only. Literal secrets already supported by Settings remain supported; this issue documents that behavior rather than claiming they are never persisted.

Add backend proxy operations:

- `POST /api/trust/memory/rebuild`
- `POST /api/trust/memory/clear-nexus` with `{ "confirmation": "CLEAR NEXUS MEMORY" }`

The backend returns `503` when the daemon is unavailable, maps validation failures to `400`, and does not expose daemon stack traces or sensitive request details.

## Memory daemon operations

Add daemon-local maintenance endpoints consumed only through the backend:

- `POST /operations/rebuild-index`
- `POST /operations/clear-nexus` with the same exact confirmation phrase

Only one maintenance operation may run at a time. A concurrent request returns `409`.

Rebuild performs a forced full re-index: it scans canonical Markdown, refreshes every memory row even when its content hash is unchanged, removes stale rows for missing files, and regenerates derived FTS, chunk, vector, and knowledge-graph state. Canonical Markdown is never unlinked. The response reports scanned, inserted, updated, removed, and reindexed counts. Model-dependent indexing may continue through the existing job queue; the response distinguishes queued work from completed scanning.

Clear selects active indexed memories where `namespace = 'nexus'`, unlinks only their canonical Markdown files, and applies the existing deletion cleanup for each record. It reports deleted and failed counts and affected paths only as vault-relative paths. A partial failure returns a non-success result with per-file safe error messages; successful deletions are not rolled back because filesystem removal is not transactional. A final re-scan reconciles the index with disk.

## README

Add a concise **Trust and privacy** section near the architecture/configuration overview. It documents:

- backend `4173`, frontend dev server `5173`, memory daemon `4100`, and local model defaults `4001`–`4003`, noting that effective values come from configuration;
- what is stored in `~/.nexus/nexus.db`, the Obsidian vault, its `.index` database, `config.yaml`, and `auth.json`;
- exact secret sources, including the possibility of masked literals in config;
- what leaves the machine for model, assistant, Jira, and GitHub calls;
- namespaces, auto-injection, archival, disabling, clearing, and rebuilding memory;
- the explicit no-application-telemetry stance without making broader claims about third-party providers.

Existing contradictory secret-storage text is corrected rather than duplicated.

## Error handling and safety

- Trust snapshot failures for an optional resolver are represented as `unknown` or `unavailable`; the rest of the section still renders.
- Raw secrets are excluded at the response-construction boundary and covered by serialization tests.
- Clear requires the exact confirmation phrase in both backend and daemon layers.
- Clear is fixed to the `nexus` namespace; the public operation accepts no namespace parameter.
- Rebuild and clear cannot overlap.
- The UI explains that clear deletes canonical Markdown, while rebuild affects only derived index state.

## Tests

Backend tests cover:

- the trust snapshot's effective paths, ports, source labels, and memory configuration;
- absence of known secret values and sensitive credential fields in serialized responses;
- environment, config interpolation/literal, Pi auth, and GitHub CLI source detection;
- daemon proxy success, unavailable, validation, and conflict responses;
- rejection of missing or incorrect clear confirmation.

Memory daemon tests cover:

- forced rebuild preserves all canonical Markdown and refreshes unchanged memories;
- rebuild removes stale index entries and reports queued/completed work accurately;
- clear deletes only `namespace = 'nexus'` canonical files and index rows;
- other namespaces and unrelated vault files survive clear;
- incorrect confirmation and concurrent maintenance operations are rejected;
- partial filesystem failures are reported and reconciled.

Frontend tests cover:

- trust groups render from the snapshot without secret values;
- loading and partial-unavailable states;
- rebuild progress, success, and failure states;
- clear remains disabled until the exact phrase is entered;
- successful clear resets the confirmation input and refreshes the snapshot.

README review verifies that documented defaults and storage behavior match the implementation.

## Out of scope

- Migrating credentials to the operating-system keychain.
- Encrypting existing `config.yaml` or `auth.json` credentials.
- Deleting memories from non-`nexus` namespaces.
- Deleting unrelated Obsidian vault files or the complete vault.
- Claiming that configured third-party providers collect no telemetry.
- Adding a standalone About view.

## Acceptance coverage

- Users can identify secret locations/sources, memory locations, local services, and outbound provider data from Settings or README.
- Settings exposes effective trust-relevant configuration without raw secrets.
- Memory can be disabled through the existing auto-injection control, rebuilt without deleting canonical Markdown, and cleared only for the Nexus namespace with explicit confirmation.
- Documentation describes current behavior, including literal config secrets, and avoids aspirational security claims.
