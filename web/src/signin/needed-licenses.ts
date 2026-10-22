import type { LicenseInfo, SchemaLicenses } from '../wire';

/** A license some Graph tables or columns need, with whether the tenant has it and what needs it. */
export interface NeededLicense {
  info: LicenseInfo;
  needs: string[];
}

/** Each license the licenses map names once, by name, with the tables (`auditLogs_signIns`) and columns (`users.signInActivity`)
 * that need it. */
export function neededLicenses(licenses: SchemaLicenses): NeededLicense[] {
  const byName = new Map<string, NeededLicense>();
  const add = (info: LicenseInfo, what: string) => {
    const known = byName.get(info.license);
    if (known) {
      known.needs.push(what);
    } else {
      byName.set(info.license, { info, needs: [what] });
    }
  };
  for (const [table, info] of Object.entries(licenses.tables)) {
    add(info, table);
  }
  for (const [table, columns] of Object.entries(licenses.columns)) {
    for (const [column, info] of Object.entries(columns)) {
      add(info, `${table}.${column}`);
    }
  }
  return [...byName.values()].sort((a, b) => a.info.license.localeCompare(b.info.license));
}
