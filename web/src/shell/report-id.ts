import { BridgeError } from '../bridge';

/** `"K7Q2M9XD"` as shown: `"K7Q2-M9XD"`. On the wire the ID is the plain 8 characters. */
export const formatReportId = (id: string): string => (id.length === 8 ? `${id.slice(0, 4)}-${id.slice(4)}` : id);

/** The report ID the host gave a caught error, if it is a bridge error that has one. */
export const reportIdOf = (e: unknown): string | undefined => (e instanceof BridgeError ? e.reportId : undefined);
