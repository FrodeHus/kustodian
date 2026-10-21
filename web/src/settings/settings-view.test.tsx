import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { applyTheme, useTheme } from '../shell/theme';
import type { AppSettings, SettingsAnswer } from '../wire';
import { SettingsView } from './settings-view';

const bridge = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge')>()),
  call: bridge.call,
  on: () => () => undefined,
}));

const defaults: AppSettings = {
  version: 1,
  theme: 'dark',
  rawDefaultVersion: 'beta',
  signIn: { clientId: null, tenant: null },
  limits: {
    graphObjectsPerTable: 50000,
    fetchBudgetMb: 512,
    engineTimeoutSeconds: 120,
    engineHeapMb: 1024,
    engineWorkers: 2,
    perObjectReadsPerTable: 2000,
    perObjectCacheMinutes: 30,
    graphRowsPerRun: 50000,
  },
};

let stored: AppSettings;
/** What `settings.set` does with the next settings it is sent; by default it stores them. */
let onSet: (settings: AppSettings) => SettingsAnswer | Promise<SettingsAnswer>;

beforeEach(() => {
  stored = defaults;
  onSet = (settings) => ({ settings, restartNeeded: false, corrupt: false });
  bridge.call.mockReset();
  bridge.call.mockImplementation((method: string, params?: { settings: AppSettings }) => {
    switch (method) {
      case 'settings.get':
        return Promise.resolve({ settings: stored, restartNeeded: false, corrupt: false });
      case 'settings.set':
        return Promise.resolve(onSet(params!.settings)).then((answer) => {
          stored = answer.settings;
          return answer;
        });
      default:
        return Promise.resolve(null);
    }
  });
});

afterEach(() => applyTheme('dark'));

const field = (label: string) => screen.getByLabelText(label).closest('.field') as HTMLElement;

describe('SettingsView', () => {
  it('settings_shows_restart_notice_and_validation_error', async () => {
    const onChange = vi.fn();
    render(<SettingsView onClose={vi.fn()} onChange={onChange} />);

    const workers = await screen.findByLabelText('Engine workers');
    expect(within(field('Engine workers')).getByText('1 to 8')).toBeTruthy();
    expect(screen.queryByText('Limits apply the next time Kustodian starts.')).toBeNull();

    // Out of range is caught before sending, huge numbers too, in the host's words.
    fireEvent.change(workers, { target: { value: '99999999999999999999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(within(field('Engine workers')).getByRole('alert').textContent).toBe('Engine workers must be between 1 and 8.');
    expect(workers.getAttribute('aria-invalid')).toBe('true');
    expect(bridge.call).not.toHaveBeenCalledWith('settings.set', expect.anything());

    // The host's own message finds its field too.
    onSet = () => Promise.reject(new BridgeError('bad_request', 'Engine timeout (seconds) must be between 10 and 3,600.'));
    fireEvent.change(workers, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const error = await within(field('Engine timeout (seconds)')).findByRole('alert');
    expect(error.textContent).toBe('Engine timeout (seconds) must be between 10 and 3,600.');
    expect(within(field('Engine workers')).queryByRole('alert')).toBeNull();

    onSet = (settings) => ({ settings, restartNeeded: true, corrupt: false });
    fireEvent.change(workers, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Limits apply the next time Kustodian starts.')).toBeTruthy();
    expect(within(field('Engine workers')).queryByRole('alert')).toBeNull();
    expect(stored.limits.engineWorkers).toBe(4);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ restartNeeded: true }));
  });

  it('settings_saves_version_and_sign_in_defaults', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Raw request version'), { target: { value: 'v1.0' } });
    fireEvent.change(screen.getByLabelText('Default client ID'), { target: { value: ' 11111111-2222-3333-4444-555555555555 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(stored.rawDefaultVersion).toBe('v1.0'));
    // An empty tenant is no tenant.
    expect(stored.signIn).toEqual({ clientId: '11111111-2222-3333-4444-555555555555', tenant: null });
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
  });

  it('theme_change_applies_immediately', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'light' } });

    // No Save needed: the window turns light at once, and the theme is kept.
    expect(document.documentElement.classList.contains('theme-light')).toBe(true);
    expect(useTheme.getState().theme).toBe('light');
    await waitFor(() => expect(stored.theme).toBe('light'));
    expect(stored.limits).toEqual(defaults.limits);
  });

  it('settings_clear_cache', async () => {
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear cached Graph objects' }));

    expect(await screen.findByText('Cached Graph objects cleared.')).toBeTruthy();
    expect(bridge.call).toHaveBeenCalledWith('cache.clear');
  });

  it('settings_says_when_the_file_was_set_aside', async () => {
    bridge.call.mockImplementation(() => Promise.resolve({ settings: defaults, restartNeeded: false, corrupt: true }));
    render(<SettingsView onClose={vi.fn()} onChange={vi.fn()} />);

    expect(await screen.findByText(/settings file couldn’t be read/)).toBeTruthy();
  });

  it('settings_closes_on_escape_and_back', async () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} onChange={vi.fn()} />);

    fireEvent.keyDown(await screen.findByLabelText('Theme'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '← Back to queries' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
