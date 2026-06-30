# Local Model Health and Curation

## Goal

Users can verify a configured local OpenAI-compatible model server from Settings, and a configured local chat model appears in the curated model list used by chats and task runs.

## Design

Nexus will add `models.local.chat_model` to the user config. When the local base URL and chat model are set, the backend writes a Nexus-managed Pi custom model registry at `~/.nexus/models.json` with provider `local`, API `openai-completions`, the configured base URL, and the configured API key or a local placeholder for keyless servers. `PiRuntime` is created with that registry path so `/api/models`, model curation, and `session.setModel(...)` all use the same model definition.

Settings will add a compact model id field and a `Test` action in the Local Model Server section. The test endpoint accepts the current unsaved local settings, resolves environment-variable key references server-side, calls `/models` for discovery, and when a model id is provided sends a small `/chat/completions` request to prove the model can answer. The response returns a short status message plus discovered model ids so the UI can show success or a concrete failure.

## Testing Notes

Backend tests should cover local model registry generation, `/api/models` inclusion and curation for `local/<model>`, and both successful and failed local health checks. Frontend tests should cover the Settings control and test-button status flow. Testing agents should also verify that after saving a local model id, `local/<model>` appears under Curated Models and can be selected in the chat model selector.

## Built

Implemented `models.local.chat_model`, Nexus-managed Pi custom model output at `~/.nexus/models.json`, runtime loading of that custom model file, Settings save-time Pi registry refresh, auto-enabling of the configured `local/<model id>` in existing curated lists, and a `POST /api/settings/local-model/test` endpoint. The Settings Local Model Server section now includes the chat model id field and a `Test local model` action that checks the unsaved form values before the user saves.

Follow-up: added `models.local.display_name` defaulting to `Local Model`. The generated Pi model keeps the configured raw model id, including filesystem-style ids such as `/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf`, but shows the display name in curated model and chat selectors. When a local API key env reference is unresolved at save time, Nexus writes Pi's local placeholder key so the model is still considered configured and can appear in curation; the health check remains the source of truth for whether the server can answer.

There were no intentional deviations from the design. The health check uses `/models` for discovery and `/chat/completions` when a model id is present, so a successful test means the configured model produced a completion response.

Testing agent verification points:

- Save a base URL, API key/env reference, display name, and chat model id, then confirm the display name appears in Curated Models and the underlying key remains `local/<model id>`.
- Enable that curated model and confirm it appears in the chat model selector.
- Use the Settings test button against both a running local server and an offline port; confirm success and failure messages are clear.
