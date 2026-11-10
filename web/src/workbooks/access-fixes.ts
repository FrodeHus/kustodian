import { refreshAudience } from '../results/refresh-audience';
import type { Widget } from './model';
import type { WidgetRun } from './workbook-store';

/** What one access step asks the host for: consent for an audience (`account.consent`), or a new token (`account.refresh`). */
export interface AccessFix {
  kind: 'consent' | 'refresh';
  audience: 'graph' | 'arm' | 'logs';
}

/** The access steps the workbook's failed widgets need, each once: consent where a run answered `consentNeeded`, a new token
 * where one answered `noPermission` (as the widget's own buttons do). */
export function accessFixes(widgets: Widget[], runs: Record<string, WidgetRun>): AccessFix[] {
  const fixes = new Map<string, AccessFix>();
  for (const w of widgets) {
    const run = runs[w.id];
    if (run?.state !== 'done') {
      continue;
    }
    const { outcome, consentAudience } = run.result;
    const fix: AccessFix | null =
      outcome === 'consentNeeded'
        ? { kind: 'consent', audience: consentAudience ?? 'arm' }
        : outcome === 'noPermission'
          ? { kind: 'refresh', audience: refreshAudience[w.query?.source ?? 'graph'] }
          : null;
    if (fix) {
      fixes.set(`${fix.kind}/${fix.audience}`, fix);
    }
  }
  return [...fixes.values()];
}
