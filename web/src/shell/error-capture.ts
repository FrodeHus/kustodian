import { BridgeError, call } from '../bridge';

type Source = 'boundary' | 'error' | 'rejection';

/** Tells the host about an error of the page's own and answers its report ID. A failure here is swallowed: reporting an error
 * about reporting errors would loop. */
export function reportUiError(e: unknown, source: Source): Promise<string | undefined> {
  const error = e instanceof Error ? e : undefined;
  return call<{ reportId: string }>('errors.report', {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(e),
    stack: error?.stack ?? '',
    source,
  }).then(
    (answer) => answer.reportId,
    () => undefined,
  );
}

/** Reports the page's uncaught errors and unhandled rejections; returns the function that stops. */
export function installErrorCapture(): () => void {
  const onError = (event: ErrorEvent) => void reportUiError(event.error ?? event.message, 'error');
  // A bridge error already went through the host, which captured it; a reason with a report ID has one.
  const onRejection = (event: PromiseRejectionEvent) => {
    if (event.reason instanceof BridgeError || (event.reason as { reportId?: unknown } | null)?.reportId) {
      return;
    }
    void reportUiError(event.reason, 'rejection');
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
