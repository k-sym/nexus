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
