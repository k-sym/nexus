# Local Model Vision Capability

## Context

Local OpenAI-compatible servers can expose image input through runtime configuration that is not visible in the base model id. A llama.cpp server, for example, may load a multimodal projector alongside a Qwen model, making the running endpoint vision-capable even when static model metadata would otherwise look text-only.

## Built

- Added `models.local.supports_images` to `NexusConfig`, defaulting to `false`.
- Settings now includes an `Image input` toggle in the Local Model Server section.
- The generated Pi local provider model now publishes `input: ['text', 'image']` when `supports_images` is enabled, and `input: ['text']` otherwise.
- `/api/settings` preserves the new local capability flag during save.
- The README config example documents `supports_images`.

## Deviations

No automatic projector probing was added. The capability is explicit because local servers vary in how they expose runtime projector state, and a text-only chat probe cannot prove image support.

## Fail-Open Image Dispatch Update (2026-08-13)

Provider catalogs can incorrectly describe a vision-capable model as text-only. Nexus therefore no longer uses model input metadata as an attachment gate:

- The composer does not disable Send or show a vision-capability warning for an attached image.
- The chat route does not reject the turn based on catalog metadata.
- When metadata omits image input, the backend applies a per-turn clone of the selected model with image input enabled so Pi does not silently strip the image. The shared registry remains unchanged.
- Attachment count, size, MIME type, and explicit-model validation are unchanged. If the provider or model cannot process the image, its normal response or error is surfaced.

The local `Image input` setting remains useful for accurately advertising the model capability to orientation and tool behavior, but it is no longer required to attempt an image turn.

## Testing Notes

- Verify that enabling `Image input` and saving Settings refreshes the local model catalog and advertises image capability.
- With a model whose metadata only advertises text input, attach an image and verify Send remains enabled, no vision warning appears, and the backend sends the image.
- Verify the per-turn override is applied even when that model key is already active in the session.
- Verify unsupported MIME types, oversized payloads, more than five attachments, and missing model selection remain blocked.

## Capability-Aware Composer Update (2026-08-17)

The fail-open path now sits behind a richer, tri-state capability contract instead of a single catalog boolean:

- `imageInput` is `supported`, `unsupported`, or `unknown`. Unknown remote metadata remains fail-open; a definitive provider result is authoritative.
- Selecting an OpenRouter model refreshes its live `input_modalities` and reasoning metadata, with a short-lived fallback cache when the provider lookup is unavailable.
- Reasoning capabilities include supported effort levels, the provider default, and whether reasoning is mandatory.
- The composer represents an untouched reasoning control as `Auto`, distinct from an explicit `Off`, and does not send a thinking parameter until the user chooses one.
- The backend resolves `Auto` to the provider/model default (or a safe supported level) before prompting, so a sticky session-level `off` cannot disable mandatory reasoning accidentally.
- Mandatory models never expose `Off`. Models with mandatory but non-configurable reasoning show a read-only `Thinking: Required` status.
- Send waits while the selected model's live capabilities are loading. A queued image becomes an inline, recoverable warning if the user switches to a definitively text-only model.

### Deviations and fallback behaviour

- Only OpenRouter currently supplies a live capability lookup. Other remote provider catalogs remain advisory when they say text-only, preserving the previous fail-open behaviour.
- The Nexus local provider remains authoritative because its `Image input` value is explicit user configuration rather than generated catalog inference.
- If the OpenRouter lookup fails, Nexus uses catalog reasoning levels and treats text-only image metadata as unknown for one minute before retrying.

### Testing notes for the capability-aware update

- Verify a mandatory-reasoning model defaults to `Thinking: Auto`, omits `Off`, and sends successfully without the user touching the selector.
- Verify an optional model exposes separate `Auto` and `Off` choices and only sends `off` after an explicit selection.
- Verify a live OpenRouter vision capability replaces stale text-only catalog metadata.
- Verify an unsupported live result blocks an image with a recovery message, while unknown metadata still attempts the turn.
- Verify changing models rapidly cannot let an older capability response re-enable Send for the newer selection.
