import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { installErrorCapture } from './error-capture';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../bridge')>()), call }));

describe('installErrorCapture', () => {
  let stop: () => void;
  beforeEach(() => {
    call.mockReset().mockResolvedValue({ reportId: 'K7Q2M9XD' });
    stop = installErrorCapture();
  });
  afterEach(() => stop());

  it('reports_a_window_error_once_with_its_source', () => {
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError('boom') }));
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('errors.report', expect.objectContaining({ name: 'TypeError', message: 'boom', source: 'error' }));
  });

  it('reports_an_unhandled_rejection_once_with_its_source', () => {
    const event = new Event('unhandledrejection') as Event & { reason: unknown };
    event.reason = new Error('late');
    window.dispatchEvent(event);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('errors.report', expect.objectContaining({ message: 'late', source: 'rejection' }));
  });

  it('does_not_report_a_rejection_the_host_already_captured', () => {
    for (const reason of [new BridgeError('bridge.failed', 'x'), Object.assign(new Error('y'), { reportId: 'K7Q2M9XD' })]) {
      const event = new Event('unhandledrejection') as Event & { reason: unknown };
      event.reason = reason;
      window.dispatchEvent(event);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('does_not_report_again_when_reporting_fails', async () => {
    call.mockRejectedValue(new Error('no host'));
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('x') }));
    await Promise.resolve();
    await Promise.resolve();
    expect(call).toHaveBeenCalledOnce();
  });
});
