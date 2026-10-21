import { call } from '../bridge';
import type { AppSettings, SettingsAnswer } from '../wire';

let last: Promise<unknown> = Promise.resolve();

/**
 * Changes the stored settings: reads them, applies `change` and writes the result. Every write of the settings from the page
 * goes through here, one after another, each reading what the one before it wrote, so a theme picked while Save is out (or the
 * other way round) can't write back settings read before the other change. A write that fails doesn't hold up the next.
 */
export function writeSettings(change: (current: AppSettings) => AppSettings): Promise<SettingsAnswer> {
  const write = last.then(async () => {
    const { settings } = await call<SettingsAnswer>('settings.get');
    // `settings.set` fills what it isn't sent with defaults, so it is always sent the whole settings.
    return call<SettingsAnswer>('settings.set', { settings: change(settings) });
  });
  last = write.catch(() => undefined);
  return write;
}
