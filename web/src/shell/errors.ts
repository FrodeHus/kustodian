/** What a caught value says, for a message to the user: an error's message, or the value as text. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
