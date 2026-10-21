import { useId, useState } from 'react';
import { call } from '../bridge';
import { findSaved, useRevisions } from '../library/saving';
import { useTabs, type Tab } from '../tabs/tab-store';
import type { ParameterDef, SavedQuery } from '../wire';
import { PARAMETER_TYPES, findParams, mergeParameters, previewText } from './find-params';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Choices as kept: each line trimmed, blank ones dropped; null when there are none. */
const cleanChoices = (choices: string[] | null | undefined) => {
  const kept = (choices ?? []).map((c) => c.trim()).filter((c) => c !== '');
  return kept.length > 0 ? kept : null;
};

function ParameterFields({ def, onChange }: { def: ParameterDef; onChange: (patch: Partial<ParameterDef>) => void }) {
  const id = useId();
  const choices = cleanChoices(def.choices);
  const label = `${def.name} · ${def.type}`;
  let value;
  if (choices) {
    const options = choices.includes(def.value) ? choices : [def.value, ...choices];
    value = (
      <select id={`${id}-value`} className="textbox mono" value={def.value} onChange={(e) => onChange({ value: e.target.value })}>
        {options.map((c) => (
          <option key={c} value={c}>
            {c === '' ? '(none)' : c}
          </option>
        ))}
      </select>
    );
  } else if (def.type === 'list') {
    value = (
      <textarea
        id={`${id}-value`}
        className="textbox mono h-auto py-1.5"
        rows={3}
        placeholder="One value per line"
        value={def.value}
        onChange={(e) => onChange({ value: e.target.value })}
      />
    );
  } else {
    value = <input id={`${id}-value`} className="textbox mono" value={def.value} onChange={(e) => onChange({ value: e.target.value })} />;
  }

  return (
    <div role="group" aria-label={def.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_auto] items-start gap-3">
      <div className="field">
        <label htmlFor={`${id}-value`}>{label}</label>
        {value}
        {def.required && def.value.trim() === '' && <span className="text-[11.5px] text-warn">Needs a value before the query runs.</span>}
      </div>
      <div className="field">
        <label htmlFor={`${id}-type`}>Type</label>
        <select id={`${id}-type`} className="textbox" value={def.type} onChange={(e) => onChange({ type: e.target.value })}>
          {PARAMETER_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-choices`}>Choices</label>
        <textarea
          id={`${id}-choices`}
          className="textbox mono h-auto py-1.5"
          rows={1}
          placeholder="One per line"
          value={(def.choices ?? []).join('\n')}
          onChange={(e) => onChange({ choices: e.target.value === '' ? null : e.target.value.split('\n') })}
        />
      </div>
      <label className="mt-[22px] flex h-8 items-center gap-1.5 text-[12px] text-muted">
        <input type="checkbox" checked={def.required} onChange={(e) => onChange({ required: e.target.checked })} />
        Required
      </label>
    </div>
  );
}

/**
 * The parameters form (spec 6.3, mockup Parameters): a field for each `{name}` in the tab's query, with its type, choices
 * (one per line) and whether it is required. The tab keeps the values. The preview of `query` (the text Run sends) is
 * written here for showing only; the host substitutes for real and checks each value. "Remember as defaults" saves the
 * parameters with the tab's saved query, leaving its text as saved.
 */
export function ParamsForm({ tab, query, onRun }: { tab: Tab; query: string; onRun: () => void }) {
  const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const previewId = useId();
  const defs = mergeParameters(findParams(tab.text), tab.parameters);

  const change = (name: string, patch: Partial<ParameterDef>) => {
    setStatus(null);
    useTabs.getState().setParameters(
      tab.id,
      defs.map((d) => (d.name === name ? { ...d, ...patch } : d)),
    );
  };

  const remember = async () => {
    const saved = tab.savedId ? await findSaved(tab.savedId) : undefined;
    if (!saved) {
      throw new Error('The saved query is no longer in the library.');
    }
    const { id, name, folder, source, text } = saved;
    const parameters = defs.map((d) => ({ ...d, choices: cleanChoices(d.choices) }));
    await call<SavedQuery>('library.save', { query: { id, name, folder, source, text, parameters } });
    useRevisions.getState().bump('library');
  };

  return (
    <section aria-label="Parameters" className="card m-3 flex flex-col gap-3.5 p-4">
      <div className="flex items-baseline gap-2">
        <b className="text-[14px]">Parameters</b>
        <span className="muted text-[12px]">Found in the query as {'{name}'}; filled in before it runs.</span>
      </div>
      {defs.map((d) => (
        <ParameterFields key={d.name} def={d} onChange={(patch) => change(d.name, patch)} />
      ))}
      <div className="field">
        <span id={previewId} className="text-[12px] font-semibold text-muted">
          The query as it will run
        </span>
        <pre aria-labelledby={previewId} className="codeblock m-0 max-h-[160px] overflow-auto">
          {previewText(query, defs)}
        </pre>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn primary" onClick={onRun}>
          Run with these values
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!tab.savedId || busy}
          title={tab.savedId ? undefined : 'Save the query to the library first.'}
          onClick={() => {
            setBusy(true);
            remember().then(
              () => {
                setBusy(false);
                setStatus({ text: 'Kept as this query’s defaults.', bad: false });
              },
              (e: unknown) => {
                setBusy(false);
                setStatus({ text: `The defaults couldn’t be kept: ${errorText(e)}`, bad: true });
              },
            );
          }}
        >
          Remember as defaults for this query
        </button>
        {status && (
          <span role={status.bad ? 'alert' : 'status'} className={`text-[12px] ${status.bad ? 'text-bad' : 'text-ok'}`}>
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}
