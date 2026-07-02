// An in-app confirmation dialog that works identically in the Tauri webview and
// a plain browser.
//
// We deliberately do NOT use window.confirm here. In the Tauri webview the
// dialog plugin replaces window.confirm with an async, capability-gated shim:
// when the `dialog:allow-confirm` capability isn't compiled into the running
// binary the command is rejected, and a naive guard either always fires (the
// Promise is truthy) or silently fails safe to "no" — which is exactly how
// Archive/Delete once broke. Instead we render our own modal (ConfirmHost) and
// resolve a real boolean, so the flow is fully in our control and traceable.
//
// confirmDialog() keeps the same `await confirmDialog(msg)` call shape the rest
// of the app already uses; only the implementation changed.

export interface ConfirmRequest {
  message: string;
  /** Called by the host with the user's choice; also dismisses the dialog. */
  resolve: (result: boolean) => void;
}

type Listener = (request: ConfirmRequest | null) => void;

let listener: Listener | null = null;

/** Register the single mounted ConfirmHost. Pass null to unregister. */
export function setConfirmListener(fn: Listener | null): void {
  listener = fn;
}

export function confirmDialog(message: string): Promise<boolean> {
  console.debug('[confirm] requested:', message);
  if (!listener) {
    // No modal host mounted — refuse rather than silently proceeding, so a
    // destructive action is never taken on an unhandled confirm.
    console.warn('[confirm] no ConfirmHost mounted; denying (fail-safe):', message);
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    listener!({
      message,
      resolve: (result: boolean) => {
        console.debug('[confirm] resolved:', message, '→', result);
        listener?.(null); // dismiss the dialog
        resolve(result);
      },
    });
  });
}
