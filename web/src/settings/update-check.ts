import { call } from '../bridge';
import type { SettingsAnswer, UpdateInfo } from '../wire';

/** Asks once at startup whether a GitHub release is newer than the running one, and whether "Skip" passed it over. */
export async function newerRelease(): Promise<UpdateInfo | null> {
  const [info, { settings }] = await Promise.all([call<UpdateInfo>('app.checkUpdate'), call<SettingsAnswer>('settings.get')]);
  return info.available && info.latest !== settings.skippedVersion ? info : null;
}
