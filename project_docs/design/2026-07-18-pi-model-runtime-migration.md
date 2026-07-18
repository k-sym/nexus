# Pi ModelRuntime migration

## Implementation

Nexus now targets `@earendil-works/pi-*` 0.80.10 and uses the unified `ModelRuntime` API introduced in 0.80.8.

- `PiRuntime.create()` asynchronously initializes `ModelRuntime` with the Nexus auth and model paths.
- Agent sessions receive `modelRuntime` instead of the removed `authStorage` and `modelRegistry` options.
- The synchronous `ModelRegistry` compatibility facade remains available to existing model-selection and extension code.
- API-key and OAuth operations use provider-owned `ModelRuntime.login()` interactions.
- Credential status uses non-secret `listCredentials()` metadata.
- Model refresh and curation backfills are awaited because refresh is now asynchronous.

## Deviations

No model catalog network refresh is performed during Nexus startup (`allowModelNetwork: false`), preserving the previous local/offline startup behaviour. OpenAI Codex OAuth still defaults to the `device_code` choice when the provider offers it.

## Verification

Testing should verify:

- API-key save/logout and persisted credential status.
- Anthropic, OpenAI Codex device-code, and GitHub Copilot OAuth flows.
- Model catalogue refresh after authentication and local-model settings changes.
- Existing and newly created Pi sessions, including model selection and extension loading.

Automated validation completed with the full workspace build/type-check, 429 backend tests, 20 memory-daemon tests, frontend tests, glasses build, and Tauri `cargo check`.
