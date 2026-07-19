# Dependency audit CI

## Implementation

GitHub Actions now audits every independently locked npm dependency group:

- the root workspace, including backend and frontend workspaces;
- the standalone glasses app;
- the standalone memory daemon.

The audit runs for dependency-related pull requests, dependency-related pushes to `main`, manual dispatches, and every Monday at 07:30 UTC. Each dependency group runs as a separate matrix job so failures identify the affected lockfile. Findings at moderate severity or higher fail the check.

The workflow uses read-only repository permissions and does not install packages or execute dependency lifecycle scripts; `npm audit` evaluates the committed lockfiles directly against npm's advisory service.

## Verification

Testing should verify that all three matrix jobs appear, scheduled/manual runs execute without a code change, and an advisory at moderate severity or higher fails only the affected matrix entry.

Local verification completed with successful audits for the root workspace, glasses app, and memory daemon, each reporting zero vulnerabilities.
