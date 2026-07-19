import { useCallback, useEffect, useState } from 'react';
import { api, type TrustSnapshot } from '../api';

const CLEAR_PHRASE = 'CLEAR NEXUS MEMORY';

export function TrustPrivacySection() {
  const [snapshot, setSnapshot] = useState<TrustSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [operation, setOperation] = useState<'rebuild' | 'clear' | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await api.trust.get());
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rebuild = async () => {
    setOperation('rebuild');
    setMessage(null);
    try {
      const result = await api.trust.rebuildMemory();
      setMessage({
        kind: 'success',
        text: `Memory index rebuilt: ${result.scanned} scanned, ${result.inserted} inserted, ${result.updated} updated, ${result.noop} unchanged, ${result.removed} removed, ${result.reindexed} reindexed, ${result.queued} jobs queued.`,
      });
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Memory index rebuild failed.' });
    } finally {
      setOperation(null);
    }
  };

  const clear = async () => {
    if (confirmation !== CLEAR_PHRASE) return;
    setOperation('clear');
    setMessage(null);
    try {
      const result = await api.trust.clearNexusMemory(confirmation);
      if (result.failed > 0 || result.ok === false) {
        setMessage({
          kind: 'error',
          text: `Nexus memory partially cleared: ${result.deleted} deleted, ${result.failed} failed.`,
        });
      } else {
        setConfirmation('');
        setMessage({ kind: 'success', text: `Nexus memory cleared: ${result.deleted} deleted.` });
      }
      await load();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Nexus memory clear failed.' });
    } finally {
      setOperation(null);
    }
  };

  const canClear = confirmation === CLEAR_PHRASE && operation === null;

  return (
    <section className="surface-glass border border-subtle rounded-lg p-4" aria-labelledby="trust-privacy-heading">
      <h2 id="trust-privacy-heading" className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Trust &amp; Privacy</h2>

      {loading && !snapshot && <p className="text-xs text-faint">Loading trust information…</p>}
      {loadError && <p className="text-xs text-amber-400">Trust information is currently unavailable.</p>}

      {snapshot && (
        <div className="space-y-5 text-xs">
          <Boundary title="Local services">
            {snapshot.services.map((service) => (
              <Row key={`${service.name}-${service.url}`} label={service.name} value={`${service.url}${service.loopback ? ' · loopback' : ''}`} />
            ))}
          </Boundary>

          <Boundary title="Storage">
            {snapshot.storage.map((item) => (
              <Row key={`${item.name}-${item.path}`} label={item.name} value={<><span>{item.path}</span><span> · {item.role}</span></>} />
            ))}
          </Boundary>

          <Boundary title="Secrets">
            {Object.entries(snapshot.secrets).map(([name, secret]) => (
              <Row
                key={name}
                label={name}
                value={`${secret.configured ? 'Configured' : 'Not configured'} · ${sourceLabel(secret.source)}${secret.location ? ` · ${secret.location}` : ''}`}
              />
            ))}
          </Boundary>

          <Boundary title="Memory boundaries">
            <Row label="Namespaces" value={snapshot.memory.namespaces.join(', ')} />
            <Row label="Auto-injection" value={snapshot.memory.autoInject.enabled
              ? `Enabled · up to ${snapshot.memory.autoInject.maxMemories} memories / ${snapshot.memory.autoInject.tokenBudget} tokens`
              : 'Disabled'} />
            <Row label="Archive" value={`Manual · ${snapshot.memory.archive.destination} · removes hot thread after successful storage`} />
          </Boundary>

          <Boundary title="Data sent to providers">
            {snapshot.outbound.map((item) => (
              <Row key={`${item.name}-${item.destination}`} label={item.name} value={`${item.enabled ? 'Enabled' : 'Disabled'} · ${item.destination} · ${item.sends.join(', ')}`} />
            ))}
            <p className="text-faint">Configured providers receive the request content required to perform their service.</p>
          </Boundary>

          <Boundary title="Telemetry">
            <p className="text-primary font-medium">No application telemetry</p>
            {snapshot.telemetry.statement !== 'No application telemetry' && <p className="text-faint">{snapshot.telemetry.statement}</p>}
          </Boundary>
        </div>
      )}

      <div className="mt-5 pt-4 border-t border-subtle space-y-3">
        <div>
          <button
            type="button"
            onClick={() => void rebuild()}
            disabled={operation !== null}
            className="px-3 py-1.5 surface-elevated rounded-sm text-xs text-primary disabled:opacity-40"
          >
            {operation === 'rebuild' ? 'Rebuilding…' : 'Rebuild memory index'}
          </button>
          <p className="text-[10px] text-faint mt-1">Regenerates the disposable search index without deleting canonical Markdown.</p>
        </div>
        <div>
          <label htmlFor="clear-nexus-confirmation" className="block text-xs text-faint mb-1">Confirmation phrase</label>
          <input
            id="clear-nexus-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={CLEAR_PHRASE}
            disabled={operation !== null}
            className="w-full surface-panel border border-subtle rounded-sm px-3 py-2 text-xs font-mono text-primary"
          />
          <button
            type="button"
            onClick={() => void clear()}
            disabled={!canClear}
            className="mt-2 px-3 py-1.5 rounded-sm text-xs bg-red-500/15 text-red-400 disabled:opacity-40"
          >
            {operation === 'clear' ? 'Clearing…' : 'Clear Nexus memory'}
          </button>
          <p className="text-[10px] text-faint mt-1">Permanently deletes canonical memory in the nexus namespace only.</p>
        </div>
        {message && <p role="status" className={message.kind === 'error' ? 'text-xs text-red-400' : 'text-xs text-green-400'}>{message.text}</p>}
      </div>
    </section>
  );
}

function Boundary({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="font-semibold text-muted mb-1.5">{title}</h3>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="grid grid-cols-[minmax(7rem,0.45fr)_1fr] gap-2"><span className="text-faint">{label}</span><span className="text-primary break-words">{value}</span></div>;
}

function sourceLabel(source: string): string {
  return source.replaceAll('-', ' ');
}
