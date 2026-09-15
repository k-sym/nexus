# Bridge client credentials in Nexus configuration
Status: accepted — Keith requested 2026-09-15.

Let chonk run nexus-bridge without sourcing a project .env. Read a dedicated bridge_client section in ~/.nexus/config.yaml, including broker and backend tokens; preserve standalone client YAML and environment overrides. Do not infer remote credentials from the local Nexus server configuration or print secrets in identity/errors. Verify the installed package outside the repository.
