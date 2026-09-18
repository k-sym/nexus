/** Mounted child blocks claim their approval cards; unmounted blocks use the global queue. */
const slots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
let version = 0;
function changed() { version++; listeners.forEach(fn => fn()); }
export function registerApprovalSlot(id: string, element: HTMLElement) {
  slots.set(id, element); changed();
  return () => { if (slots.get(id) === element) { slots.delete(id); changed(); } };
}
export function approvalSlot(id?: string) { return id ? slots.get(id) : undefined; }
export function subscribeApprovalSlots(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function approvalSlotsVersion() { return version; }
