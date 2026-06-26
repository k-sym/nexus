# Daemon Toast Acknowledgement

## Built

- Memory daemon health toasts now persist dismissals in browser storage.
- Dismissals are keyed by alert id and message, so the same dead-letter warning stays hidden after restarting Nexus.
- If the condition changes, such as the dead-letter count increasing, Nexus shows a fresh warning.
- When a condition clears, stale dismissal keys are pruned so future recurrences can notify again.

## Testing Notes

- Verify dismissing `N memory job(s) failed (dead-lettered)` hides it after remount/restart while the count is unchanged.
- Verify the toast appears again if the dead-letter count changes.
- Verify ordinary notification toasts remain separate from memory health toasts.
