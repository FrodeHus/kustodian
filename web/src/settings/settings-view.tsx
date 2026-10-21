import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BridgeError, call } from '../bridge';
import { RAW_VERSIONS } from '../raw/raw-request';
import { errorText } from '../shell/errors';
import { chooseTheme } from '../shell/theme';
import type { AppSettings, SettingsAnswer, Theme } from '../wire';
import { writeSettings } from './settings-writes';

/**
 * The limits as the settings screen shows them, with the ranges the host allows. The host (`SettingsService`) checks them and
 * its message for one out of range starts with the name here, which is how the message finds its field.
 */
const LIMITS: { key: string; name: string; min: number; max: number }[] = [
  { key: 'graphObjectsPerTable', name: 'Graph objects per table', min: 1_000, max: 1_000_000 },
  { key: 'fetchBudgetMb', name: 'Graph fetch budget per run (MB)', min: 64, max: 8_192 },
  { key: 'engineTimeoutSeconds', name: 'Engine timeout (seconds)', min: 10, max: 3_600 },
  { key: 'engineHeapMb', name: 'Engine heap limit per worker (MB)', min: 256, max: 16_384 },
  { key: 'engineWorkers', name: 'Engine workers', min: 1, max: 8 },
  { key: 'perObjectReadsPerTable', name: 'Per-object reads per table', min: 0, max: 20_000 },
  { key: 'perObjectCacheMinutes', name: 'Per-object cache (minutes)', min: 0, max: 1_440 },
  { key: 'graphRowsPerRun', name: 'Rows returned per Graph run', min: 1_000, max: 1_000_000 },
];

const THEMES: { value: Theme; name: string }[] = [
  { value: 'dark', name: 'Dark' },
  { value: 'light', name: 'Light' },
  { value: 'system', name: 'Follow the system' },
];

const count = (n: number) => n.toLocaleString('en-US');

/** A control's attributes for its field's message, if it has one. */
const invalid = (id: string, error: string | undefined) => (error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {});

/** The field a host message is about: a limit by its name, the theme or the version by theirs; null for any other. */
function fieldOf(message: string): string | null {
  const limit = LIMITS.find((l) => message.startsWith(`${l.name} `));
  if (limit) {
    return limit.key;
  }
  if (message.startsWith('Theme ')) {
    return 'theme';
  }
  return message.startsWith('The raw request version') ? 'rawDefaultVersion' : null;
}

interface Draft {
  rawDefaultVersion: string;
  clientId: string;
  tenant: string;
  limits: Record<string, string>;
}

const draftOf = (s: AppSettings): Draft => ({
  rawDefaultVersion: s.rawDefaultVersion,
  clientId: s.signIn.clientId ?? '',
  tenant: s.signIn.tenant ?? '',
  limits: Object.fromEntries(LIMITS.map((l) => [l.key, String(s.limits[l.key] ?? '')])),
});

interface SettingsViewProps {
  onClose: () => void;
  /** The settings were saved: what the host stored. */
  onChange: (answer: SettingsAnswer) => void;
}

/**
 * Settings (spec 6.11 and 9): the theme, which applies at once; the raw request tab's default version; the sign-in screen's
 * default client ID and tenant; the limits with their ranges, which apply the next time Kustodian starts; and clearing the
 * cached Graph objects. The host checks every value, and its message shows beside the field it is about.
 */
export function SettingsView({ onClose, onChange }: SettingsViewProps) {
  const [stored, setStored] = useState<SettingsAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [theme, setTheme] = useState<Theme>('dark');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const back = useRef<HTMLButtonElement>(null);

  // The view takes focus as it opens, so Esc closes it straight away.
  useEffect(() => back.current?.focus(), []);

  useEffect(() => {
    call<SettingsAnswer>('settings.get').then(
      (answer) => {
        setStored(answer);
        setDraft(draftOf(answer.settings));
        setTheme(answer.settings.theme);
      },
      (e: unknown) => setLoadError(`The settings couldn’t be read: ${errorText(e)}`),
    );
  }, []);

  const pickTheme = (next: Theme) => {
    setTheme(next);
    chooseTheme(next).then(
      () => setStored((s) => s && { ...s, settings: { ...s.settings, theme: next } }),
      (e: unknown) => setStatus({ tone: 'bad', text: `The theme couldn’t be kept for the next start: ${errorText(e)}` }),
    );
  };

  async function save() {
    if (!stored || !draft) {
      return;
    }
    const wrong: Record<string, string> = {};
    const limits: Record<string, number> = { ...stored.settings.limits };
    for (const l of LIMITS) {
      const text = draft.limits[l.key]?.trim() ?? '';
      const value = Number(text);
      if (!/^\d+$/.test(text)) {
        wrong[l.key] = `${l.name} must be a whole number.`;
      } else if (value < l.min || value > l.max) {
        // As the host words it; checked here too, so a number too big for the host to read gets the same message.
        wrong[l.key] = `${l.name} must be between ${count(l.min)} and ${count(l.max)}.`;
      } else {
        limits[l.key] = value;
      }
    }
    setErrors(wrong);
    setStatus(null);
    if (Object.keys(wrong).length > 0) {
      return;
    }
    const edited: Omit<AppSettings, 'version'> = {
      theme,
      rawDefaultVersion: draft.rawDefaultVersion,
      signIn: { clientId: draft.clientId.trim() || null, tenant: draft.tenant.trim() || null },
      limits,
    };
    setBusy(true);
    try {
      // After any theme write that is out, and over what it stored.
      const answer = await writeSettings((current) => ({ ...current, ...edited, limits: { ...current.limits, ...limits } }));
      setStored(answer);
      setDraft(draftOf(answer.settings));
      setStatus({ tone: 'ok', text: 'Settings saved.' });
      onChange(answer);
    } catch (e) {
      const message = errorText(e);
      const field = e instanceof BridgeError && e.code === 'bad_request' ? fieldOf(message) : null;
      if (field) {
        setErrors({ [field]: message });
      } else {
        setStatus({ tone: 'bad', text: `The settings couldn’t be saved: ${message}` });
      }
    } finally {
      setBusy(false);
    }
  }

  const clearCache = () =>
    call('cache.clear').then(
      () => setStatus({ tone: 'ok', text: 'Cached Graph objects cleared.' }),
      (e: unknown) => setStatus({ tone: 'bad', text: `The cache couldn’t be cleared: ${errorText(e)}` }),
    );

  const edit = (change: Partial<Draft>) => setDraft((d) => d && { ...d, ...change });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-16 py-10"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onClose();
        }
      }}
    >
      <div>
        <button ref={back} type="button" className="btn ghost" onClick={onClose}>
          ← Back to queries
        </button>
      </div>
      <h1 className="m-0 text-[22px] leading-7 font-semibold">Settings</h1>
      {loadError && (
        <span className="text-[12px] text-bad" role="alert">
          {loadError}
        </span>
      )}
      {stored?.corrupt && (
        <div className="card border-warn p-4 text-[12px] text-warn" role="note">
          The settings file couldn’t be read, so it was set aside and the defaults are in use. Saving writes a new one.
        </div>
      )}
      {stored?.unreadable && !stored.corrupt && (
        <div className="card border-warn p-4 text-[12px] text-warn" role="note">
          The settings file couldn’t be read, so the defaults are in use. Saving writes over it.
        </div>
      )}
      {stored && draft && (
        <div className="flex max-w-[880px] flex-col gap-4">
          <Card title="Appearance">
            <SettingField id="setting-theme" label="Theme" error={errors.theme} hint="Applies at once.">
              <select id="setting-theme" {...invalid('setting-theme', errors.theme)} className="textbox w-[220px]" value={theme} onChange={(e) => pickTheme(e.target.value as Theme)}>
                {THEMES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.name}
                  </option>
                ))}
              </select>
            </SettingField>
          </Card>
          <Card title="Raw requests">
            <SettingField id="setting-version" label="Raw request version" error={errors.rawDefaultVersion} hint="The Graph version a new raw request tab starts with. KQL tabs always use beta.">
              <select
                id="setting-version"
                {...invalid('setting-version', errors.rawDefaultVersion)}
                className="textbox font-mono w-[220px]"
                value={draft.rawDefaultVersion}
                onChange={(e) => edit({ rawDefaultVersion: e.target.value })}
              >
                {RAW_VERSIONS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </SettingField>
          </Card>
          <Card title="Sign-in">
            <span className="muted text-[12px]">When set, the sign-in screen starts with “My own app registration” filled in with these.</span>
            <div className="grid grid-cols-2 gap-3">
              <SettingField id="setting-client" label="Default client ID">
                <input
                  id="setting-client"
                  className="textbox font-mono"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  spellCheck={false}
                  value={draft.clientId}
                  onChange={(e) => edit({ clientId: e.target.value })}
                />
              </SettingField>
              <SettingField id="setting-tenant" label="Default tenant">
                <input
                  id="setting-tenant"
                  className="textbox font-mono"
                  placeholder="organizations or a tenant ID"
                  spellCheck={false}
                  value={draft.tenant}
                  onChange={(e) => edit({ tenant: e.target.value })}
                />
              </SettingField>
            </div>
          </Card>
          <Card title="Limits">
            {stored.restartNeeded && (
              <span className="chip warn self-start" role="status">
                Limits apply the next time Kustodian starts.
              </span>
            )}
            <div className="grid grid-cols-2 gap-3">
              {LIMITS.map((l) => (
                <SettingField key={l.key} id={`setting-${l.key}`} label={l.name} error={errors[l.key]} hint={`${count(l.min)} to ${count(l.max)}`}>
                  <input
                    id={`setting-${l.key}`}
                    {...invalid(`setting-${l.key}`, errors[l.key])}
                    className="textbox font-mono"
                    inputMode="numeric"
                    value={draft.limits[l.key] ?? ''}
                    onChange={(e) => edit({ limits: { ...draft.limits, [l.key]: e.target.value } })}
                  />
                </SettingField>
              ))}
            </div>
          </Card>
          <div className="flex items-center gap-3">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => void clearCache()}>
              Clear cached Graph objects
            </button>
            {status && (
              <span className={`text-[12px] ${status.tone === 'bad' ? 'text-bad' : 'text-muted'}`} role={status.tone === 'bad' ? 'alert' : 'status'}>
                {status.text}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card flex flex-col gap-3 p-5" aria-label={title}>
      <b className="text-[14px]">{title}</b>
      {children}
    </section>
  );
}

interface SettingFieldProps {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}

/** A setting with its label, a hint (such as its range) and the host's message about it. The control is the child with `id`;
 * {@link invalid} marks it and points it at the message. */
function SettingField({ id, label, error, hint, children }: SettingFieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="faint text-[12px]">{hint}</span>}
      {error && (
        <span className="text-[12px] text-bad" role="alert" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}
