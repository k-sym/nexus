// A confirm() that works in both the Tauri webview and a plain browser.
//
// In a browser, window.confirm is a synchronous boolean. Inside the Tauri
// webview the dialog plugin overrides window.confirm with an async shim that
// returns a Promise<boolean> and is gated by the `dialog:allow-confirm`
// capability — so `if (window.confirm(...))` is always truthy (a Promise) and
// rejects when the permission is missing (the "dialog.confirm not allowed"
// error). Awaiting Promise.resolve() collapses both shapes to a real boolean;
// on any failure we fail safe and treat it as "no" so a destructive action is
// never taken on an unhandled dialog error.
export async function confirmDialog(message: string): Promise<boolean> {
  try {
    return Boolean(await Promise.resolve(window.confirm(message) as boolean | Promise<boolean>));
  } catch {
    return false;
  }
}
