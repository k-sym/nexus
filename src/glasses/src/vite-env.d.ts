/// <reference types="vite/client" />

// Build-time knob: default the app to a ?sim scenario when set (used to test on
// the glasses, where the Even loader drops query strings). See App.tsx / main.tsx.
interface ImportMetaEnv {
  readonly VITE_FORCE_SIM?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
