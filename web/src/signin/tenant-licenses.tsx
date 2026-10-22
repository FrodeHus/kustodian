import { useEffect, useState } from 'react';
import { useSchemas } from '../schema/schema-store';
import type { LicenseState } from '../wire';
import { neededLicenses } from './needed-licenses';

const TONE: Record<LicenseState, string> = { available: 'ok', missing: 'bad', unknown: '' };
const STATE: Record<LicenseState, string> = {
  available: 'The tenant has it.',
  missing: "The tenant doesn't have it.",
  unknown: "The tenant's licenses couldn't be checked.",
};

/** The licenses Graph tables and columns need, and whether the active account's tenant has them (`schema.licenses`, shared
 * with the schema panel's tags). "Refresh" reads the tenant's subscriptions from Graph again rather than the host's copy, which
 * is kept for a day. `accountKey` is the active account's: another one reads its tenant's licenses. */
export function TenantLicenses({ accountKey }: { accountKey: string }) {
  const licenses = useSchemas((s) => s.licenses);
  const loadLicenses = useSchemas((s) => s.loadLicenses);
  const [refreshing, setRefreshing] = useState(false);
  /** The account whose licenses were asked for here: an answer of null after that means they couldn't be read. */
  const [readFor, setReadFor] = useState<string | null>(null);

  useEffect(() => {
    // The schema panel reads them with the Graph schema; with no Graph tab open yet they haven't been read.
    if (!useSchemas.getState().licenses) {
      void useSchemas
        .getState()
        .loadLicenses()
        .finally(() => setReadFor(accountKey));
    }
  }, [accountKey]);

  const refresh = () => {
    setRefreshing(true);
    void loadLicenses({ refresh: true }).finally(() => {
      setRefreshing(false);
      setReadFor(accountKey);
    });
  };

  const reading = refreshing || (!licenses && readFor !== accountKey);
  const needed = licenses ? neededLicenses(licenses) : [];
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2.5" role="group" aria-label="Tenant licenses">
      <div className="flex items-center justify-between gap-2">
        <b className="text-[13px]">Tenant licenses</b>
        <button type="button" className="btn" disabled={reading} onClick={refresh}>
          {reading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <span className="muted text-[12px]">
        The licenses some Graph tables and columns need. A table needing one the tenant lacks isn’t read; a column is left out.
      </span>
      {licenses && !licenses.known && (
        <span className="faint text-[12px]" role="status">
          {licenses.reason ?? 'The tenant’s licenses couldn’t be read.'}
        </span>
      )}
      {!licenses && !reading && (
        <span className="faint text-[12px]" role="status">
          The tenant’s licenses couldn’t be read.
        </span>
      )}
      {needed.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Licenses">
          {needed.map(({ info, needs }) => (
            <li
              key={info.license}
              className={`chip ${TONE[info.state]}`}
              title={`${STATE[info.state]} Needed by ${needs.join(', ')}.\n${info.source}`}
              aria-label={`${info.license}: ${STATE[info.state]}`}
            >
              {info.license}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
