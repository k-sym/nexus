import { FormEvent, useState } from 'react';
import type { QuestionAnswer, QuestionRequest, QuestionToolResult } from '../lib/questions';

export interface QuestionCardProps {
  request: QuestionRequest;
  answeredResult?: QuestionToolResult;
  unavailable?: boolean;
  submitting?: boolean;
  error?: string;
  onSubmit: (answers: QuestionAnswer[]) => Promise<void>;
}

interface DraftAnswer {
  selected: string[];
  custom: string;
}

export function QuestionCard({
  request,
  answeredResult,
  unavailable = false,
  submitting = false,
  error,
  onSubmit,
}: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(() =>
    Object.fromEntries(request.questions.map((question) => [question.id, { selected: [], custom: '' }])));

  const inactive = unavailable || answeredResult?.status === 'cancelled';

  if (inactive) {
    return (
      <section className="rounded-lg border border-slate-700 bg-slate-900/60 p-4">
        <p className="text-sm text-slate-400">This question is no longer active</p>
      </section>
    );
  }

  if (answeredResult?.status === 'answered') {
    return (
      <section className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/60 p-4">
        {request.questions.map((question) => {
          const answer = answeredResult.answers.find((candidate) => candidate.questionId === question.id);
          const values = (answer?.selected ?? []).map((value) =>
            question.options.find((option) => option.value === value)?.label ?? value);
          if (answer?.custom) values.push(answer.custom);
          return (
            <div key={question.id}>
              <h3 className="text-sm font-medium text-slate-200">{question.header}</h3>
              <p className="text-sm text-slate-400">{question.question}</p>
              <p className="mt-1 text-sm text-slate-200">{values.join(', ')}</p>
            </div>
          );
        })}
      </section>
    );
  }

  const complete = request.questions.every((question) => {
    const draft = drafts[question.id];
    return draft.selected.length > 0 || (question.allowOther && draft.custom.trim().length > 0);
  });

  function select(questionId: string, value: string, multiple: boolean) {
    setDrafts((current) => {
      const draft = current[questionId];
      const selected = multiple
        ? draft.selected.includes(value)
          ? draft.selected.filter((candidate) => candidate !== value)
          : [...draft.selected, value]
        : [value];
      return { ...current, [questionId]: { ...draft, selected } };
    });
  }

  function setCustom(questionId: string, custom: string) {
    setDrafts((current) => ({
      ...current,
      [questionId]: { ...current[questionId], custom },
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete || submitting) return;
    await onSubmit(request.questions.map((question) => {
      const draft = drafts[question.id];
      const custom = draft.custom.trim();
      return {
        questionId: question.id,
        selected: draft.selected,
        ...(custom ? { custom } : {}),
      };
    }));
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-slate-700 bg-slate-900/60 p-4">
      {request.questions.map((question) => {
        const draft = drafts[question.id];
        const inputType = question.multiple ? 'checkbox' : 'radio';
        return (
          <fieldset key={question.id} disabled={submitting} className="space-y-2">
            <legend className="text-sm font-medium text-slate-200">{question.header}</legend>
            <p className="text-sm text-slate-400">{question.question}</p>
            <div className="space-y-2">
              {question.options.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-700 p-2">
                  <input
                    type={inputType}
                    name={question.id}
                    value={option.value}
                    checked={draft.selected.includes(option.value)}
                    onChange={() => select(question.id, option.value, question.multiple)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-slate-200">{option.label}</span>
                    {option.description && <span className="block text-xs text-slate-400">{option.description}</span>}
                  </span>
                </label>
              ))}
            </div>
            {question.allowOther && (
              <label className="block text-sm text-slate-300">
                Other
                <input
                  type="text"
                  aria-label={`Other answer for ${question.header}`}
                  value={draft.custom}
                  onChange={(event) => setCustom(question.id, event.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200"
                />
              </label>
            )}
          </fieldset>
        );
      })}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={!complete || submitting}
        className="rounded-md bg-blue-600 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit answers'}
      </button>
    </form>
  );
}
