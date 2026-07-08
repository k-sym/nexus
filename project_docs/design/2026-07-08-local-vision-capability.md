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

## Testing Notes

Verify that enabling `Image input` and saving Settings refreshes the local model catalog, removes the composer's image-blocking warning for the selected local model, and allows an image turn to reach the local server.
