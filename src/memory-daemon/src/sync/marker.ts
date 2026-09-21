// The vault marker: `<vault>/.nexus-vault`, a hidden file the daemon stamps the first time
// it writes into or indexes a vault. Its READABILITY is the readiness signal for the boot
// reindex's missing-file pass: on a synced or File-Provider mount, directories can be
// listed while the tree is still empty or half-hydrated, so "the folder exists" proves
// nothing — but a file whose bytes come back has been fetched, and the enumeration of
// its siblings is complete by then. Dot-files are skipped by the walker and by Obsidian.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const VAULT_MARKER = ".nexus-vault";

export function markerPath(vaultPath: string): string {
  return join(vaultPath, VAULT_MARKER);
}

/** True when the marker exists AND its bytes can be read (hydrated, not a placeholder). */
export function vaultReady(vaultPath: string): boolean {
  try {
    return readFileSync(markerPath(vaultPath), "utf8").length > 0;
  } catch {
    return false;
  }
}

/** Stamp the vault (idempotent). Creates the directory for a fresh install. */
export function ensureVaultMarker(vaultPath: string): void {
  const p = markerPath(vaultPath);
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `nexus-memory vault\ncreated: ${new Date().toISOString()}\n`, "utf8");
}
