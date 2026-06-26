# Activity Filtered Status Results

## Built

- Activity kind and status filters now drive `GET /api/activity` query parameters instead of only filtering the rows already loaded in the browser.
- The activity route applies `status` consistently to running rows, recent rows, and status counts.
- Selecting `Failed` should return failed operations from storage even when those failures are older than the default unfiltered recent window.

## Deviations

- Search remains a client-side filter over the server-returned rows. This keeps the change scoped to the status/kind mismatch reported in Activity.

## Testing Notes

- Verify `GET /api/activity?status=failed` returns only failed operations and does not include running rows.
- Verify the Activity Console `Failed` filter triggers a server-backed reload, then shows failed jobs when the failed count is non-zero.
- Verify default Activity view still shows running plus recent non-running operations.
