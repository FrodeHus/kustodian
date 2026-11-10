/** An id as the pickers show it: the first and last 4 characters. */
export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
