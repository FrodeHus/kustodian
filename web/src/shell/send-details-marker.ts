/** Marks the root of the Send details dialog, which is portaled to the body from inside other modals. */
export const SEND_DETAILS_ATTRIBUTE = 'data-send-details';

/** Whether an event's target is inside the Send details dialog: the focus traps of the modals it opens from let it be. */
export const inSendDetails = (target: EventTarget | null): boolean => target instanceof Element && target.closest(`[${SEND_DETAILS_ATTRIBUTE}]`) !== null;
