import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ptyWsUrl } from '../api';

export default function TerminalPane({ threadId }: { threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#09090b' }, // zinc-950
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const ws = new WebSocket(ptyWsUrl(threadId));
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') term.write(msg.data);
      } catch { /* ignore non-JSON frames */ }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));

    const dataSub = term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const onResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [threadId]);

  return <div ref={hostRef} className="h-full w-full bg-zinc-950 p-2" />;
}
