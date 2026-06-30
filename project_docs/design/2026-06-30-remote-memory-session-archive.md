# Remote Memory Session Archive

## Context

Issue #128 reported that archiving a session failed when Nexus was configured to use a remote memory daemon. Memory retrieval worked because it already used `memory.daemon_url`, but session archive summarization still called the Nexus backend's local model endpoint.

## Built

- Added `POST /operations/summarize-session-archive` to the memory daemon.
- Changed backend session archiving to request archive summaries from the configured memory daemon before storing the resulting memory.
- Kept the existing archive deletion rule: the hot chat thread is deleted only after the summary is stored successfully.
- Added a dismiss button to the archive failure banner so a failed archive no longer leaves a stuck toast.

## Deviations

No behavioral deviation from the existing archive contract. The summarization responsibility moved from the Nexus backend process to the memory daemon process so remote memory deployments use the daemon host's model stack.

## Testing Notes

Verify with a remote memory daemon where the local Nexus machine has no generation model running:

- Memory recall and listing still work.
- Archiving a meaningful session calls the remote daemon, stores a `session_archive` memory, deletes the active thread, and drops the Pi session files.
- If archive summarization or storage fails, the source thread remains visible.
- The archive failure banner can be dismissed.
