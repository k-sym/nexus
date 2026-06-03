import { useState } from 'react';
import { Ask, Reply } from '@nexus/shared';
import { api } from '../api';

interface QuestionCardProps {
  ask: Ask;
  /** Text shown above the questions (the assistant's preamble). */
  preamble: string;
  threadId: string;
  questionMessageId: string;
  /** True once a later turn exists — render read-only. */
  answered: boolean;
  /** The user's recorded replies, when answered. */
  answeredReplies?: Reply[];
  /** Called after a successful submit so the parent can refetch the thread. */
  onAnswered: () => void;
}

const CARD = 'bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm space-y-3 max-w-[75%]';

export default function QuestionCard({ ask, preamble, threadId, questionMessageId, answered, answeredReplies, onAnswered }: QuestionCardProps) {
  const [selected, setSelected] = useState<string[][]>(ask.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(ask.questions.map(() => ''));
  const [submitting, setSubmitting] = useState(false);

  const toggle = (qi: number, label: string, multiple: boolean) => {
    setSelected(prev => {
      const next = prev.map(a => [...a]);
      if (multiple) {
        const set = new Set(next[qi]);
        if (set.has(label)) set.delete(label); else set.add(label);
        next[qi] = [...set];
      } else {
        next[qi] = [label];
      }
      return next;
    });
  };

  const complete = ask.questions.every((_, i) => selected[i].length > 0 || custom[i].trim().length > 0);

  const submit = async () => {
    if (!complete || submitting) return;
    setSubmitting(true);
    const replies: Reply[] = ask.questions.map((q, i) => ({
      header: q.header,
      selected: selected[i],
      ...(custom[i].trim() ? { custom: custom[i].trim() } : {}),
    }));
    try {
      await api.chat.answer(threadId, questionMessageId, replies);
      onAnswered();
    } catch (err) {
      console.error('Failed to submit answer:', err);
      setSubmitting(false);
    }
  };

  // Read-only state after the question has been answered.
  if (answered) {
    return (
      <div className={`${CARD} text-zinc-300`}>
        {preamble && <p className="whitespace-pre-wrap">{preamble}</p>}
        {ask.questions.map((q, i) => {
          const chosen = answeredReplies?.[i];
          const picks = chosen ? [...chosen.selected, ...(chosen.custom ? [chosen.custom] : [])] : [];
          return (
            <div key={i} className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">{q.header}</div>
              <div className="text-zinc-200">{q.question}</div>
              <div className="flex flex-wrap gap-1">
                {q.options.map(o => (
                  <span key={o.label} className={`text-xs px-2 py-0.5 rounded border ${picks.includes(o.label) ? 'bg-indigo-500/20 border-indigo-500 text-indigo-200' : 'border-zinc-700 text-zinc-500'}`}>{o.label}</span>
                ))}
                {chosen?.custom && (
                  <span className="text-xs px-2 py-0.5 rounded border bg-indigo-500/20 border-indigo-500 text-indigo-200">✎ {chosen.custom}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`${CARD} text-zinc-200`}>
      {preamble && <p className="whitespace-pre-wrap">{preamble}</p>}
      {ask.questions.map((q, qi) => (
        <div key={qi} className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">{q.header}</div>
          <div className="text-zinc-100">{q.question}</div>
          <div className="space-y-1">
            {q.options.map(o => (
              <label key={o.label} className="flex items-start gap-2 cursor-pointer hover:bg-zinc-800/50 rounded px-2 py-1">
                <input
                  type={q.multiple ? 'checkbox' : 'radio'}
                  name={`q-${questionMessageId}-${qi}`}
                  checked={selected[qi].includes(o.label)}
                  onChange={() => toggle(qi, o.label, q.multiple)}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-zinc-100">{o.label}</span>
                  {o.description && <span className="block text-xs text-zinc-500">{o.description}</span>}
                </span>
              </label>
            ))}
            {q.custom && (
              <input
                type="text"
                value={custom[qi]}
                onChange={(e) => setCustom(prev => { const n = [...prev]; n[qi] = e.target.value; return n; })}
                placeholder="Type your own answer…"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200 mt-1"
              />
            )}
          </div>
        </div>
      ))}
      <button
        onClick={submit}
        disabled={!complete || submitting}
        className="bg-indigo-500 hover:bg-indigo-400 disabled:opacity-40 disabled:cursor-not-allowed text-ink text-sm rounded px-3 py-1.5"
      >
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  );
}
