import { useEffect, useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeError } from '../bridge';
import { ErrorBoundary, ErrorReportActions } from './error-report';
import { formatReportId, reportIdOf } from './report-id';
import { inSendDetails } from './send-details-marker';

const call = vi.hoisted(() => vi.fn());
vi.mock('../bridge', async (importOriginal) => ({ ...(await importOriginal<typeof import('../bridge')>()), call }));

const report = {
  reportId: 'K7Q2M9XD',
  kind: 'bridge.failed',
  sections: [
    { key: 'message', title: 'Message', text: 'It broke.', editable: false },
    { key: 'query', title: 'Query', text: 'users | take 1', editable: true },
  ],
};

function answer(details: { report: typeof report | null; canSend: boolean }) {
  call.mockImplementation((method: string) => Promise.resolve(method === 'errors.details' ? details : { sent: true }));
}

const ui = { message: 'It broke.', query: 'users | take 5' };

describe('report ids', () => {
  it('format_report_id_puts_a_dash_in_the_middle', () => {
    expect(formatReportId('K7Q2M9XD')).toBe('K7Q2-M9XD');
  });

  it('report_id_of_reads_a_bridge_errors_id_only', () => {
    expect(reportIdOf(new BridgeError('failed', 'x', 'K7Q2M9XD'))).toBe('K7Q2M9XD');
    expect(reportIdOf(new BridgeError('failed', 'x'))).toBeUndefined();
    expect(reportIdOf(new Error('x'))).toBeUndefined();
    expect(reportIdOf('x')).toBeUndefined();
  });
});

describe('ErrorReportActions', () => {
  beforeEach(() => {
    call.mockReset();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('renders_nothing_without_an_id', () => {
    const { container } = render(<ErrorReportActions uiSections={ui} />);
    expect(container.innerHTML).toBe('');
    expect(call).not.toHaveBeenCalled();
  });

  it('shows_the_id_and_copies_the_dashed_form', async () => {
    answer({ report, canSend: true });
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    expect(screen.getByText('Report ID: K7Q2-M9XD')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('K7Q2-M9XD'));
  });

  it('offers_no_send_when_the_build_cannot_send', async () => {
    answer({ report, canSend: false });
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    await waitFor(() => expect(call).toHaveBeenCalledWith('errors.details', { reportId: 'K7Q2M9XD' }));
    expect(screen.queryByRole('button', { name: 'Send details' })).toBeNull();
    expect(screen.getByText('Report ID: K7Q2-M9XD')).toBeTruthy();
  });

  it('shows_every_section_checked_with_the_warning_and_sends_what_is_shown', async () => {
    answer({ report, canSend: true });
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    await screen.findByRole('dialog');
    expect((screen.getByRole('checkbox', { name: 'Message' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Query' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/may contain data from your tenant/).textContent).toMatch(/Application Insights.*90 days/);
    expect((screen.getByLabelText('Message text') as HTMLTextAreaElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText('Query text'), { target: { value: 'users | take 1 // edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('errors.send', {
        reportId: 'K7Q2M9XD',
        sections: { message: 'It broke.', query: 'users | take 1 // edited' },
      }),
    );
  });

  it('leaves_out_an_unchecked_section', async () => {
    answer({ report, canSend: true });
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Query' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('errors.send', { reportId: 'K7Q2M9XD', sections: { message: 'It broke.' } }));
  });

  it('sends_nothing_on_cancel', async () => {
    answer({ report, canSend: true });
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalledWith('errors.send', expect.anything());
  });

  it('offers_the_pages_own_sections_when_the_details_are_gone', async () => {
    answer({ report: null, canSend: true });
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    await screen.findByRole('dialog');
    expect(screen.getByText(/no longer available/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('errors.send', { reportId: 'K7Q2M9XD', sections: { query: 'users | take 5', message: 'It broke.' } }),
    );
  });
});

describe('Send details dialog, opened', () => {
  beforeEach(() => call.mockReset());

  it('asks_again_on_open_and_offers_the_pages_sections_when_the_report_is_gone_by_then', async () => {
    let asked = 0;
    call.mockImplementation((method: string) =>
      Promise.resolve(method === 'errors.details' ? { report: ++asked === 1 ? report : null, canSend: true } : { sent: true }),
    );
    render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    await screen.findByText(/no longer available/);
    expect(asked).toBe(2);
  });

  it('resets_the_dialog_when_a_new_error_replaces_the_old_one', async () => {
    answer({ report, canSend: true });
    const { rerender } = render(<ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Message' }));
    expect((screen.getByRole('checkbox', { name: 'Message' }) as HTMLInputElement).checked).toBe(false);
    rerender(<ErrorReportActions reportId="ABCD2345" uiSections={ui} />);
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Message' }) as HTMLInputElement).checked).toBe(true));
  });

  it('escape_closes_only_the_dialog_not_its_opener', async () => {
    answer({ report, canSend: true });
    const outer = vi.fn();
    const doc = vi.fn();
    document.addEventListener('keydown', doc);
    render(
      <div onKeyDown={outer}>
        <ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />
      </div>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    expect(doc).not.toHaveBeenCalled();
    document.removeEventListener('keydown', doc);
  });
});

describe('Send details dialog inside a modal with a focus trap', () => {
  beforeEach(() => call.mockReset());

  function Parent({ onKey }: { onKey: () => void }) {
    const input = useRef<HTMLInputElement>(null);
    const box = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const onFocusIn = (e: FocusEvent) => {
        if (!inSendDetails(e.target) && !(e.target instanceof Node && box.current?.contains(e.target))) {
          input.current?.focus();
        }
      };
      document.addEventListener('focusin', onFocusIn);
      return () => document.removeEventListener('focusin', onFocusIn);
    }, []);
    return (
      <div ref={box} onKeyDown={onKey}>
        <input ref={input} aria-label="parent" />
        <ErrorReportActions reportId="K7Q2M9XD" uiSections={ui} />
      </div>
    );
  }

  it('keeps_focus_in_the_dialog_and_hides_keys_from_the_parent', async () => {
    answer({ report, canSend: true });
    const onKey = vi.fn();
    render(<Parent onKey={onKey} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send details' }));
    const query = (await screen.findByLabelText('Query text')) as HTMLTextAreaElement;
    query.focus();
    expect(document.activeElement).toBe(query);
    fireEvent.keyDown(query, { key: 'Enter' });
    fireEvent.keyDown(query, { key: 'Tab' });
    expect(onKey).not.toHaveBeenCalled();
    fireEvent.keyDown(query, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary', () => {
  it('reports_a_render_error_and_shows_its_id', async () => {
    call.mockReset().mockImplementation((method: string) =>
      Promise.resolve(method === 'errors.report' ? { reportId: 'K7Q2M9XD' } : { report: null, canSend: true }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Bomb = () => {
      throw new Error('render failed');
    };
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(await screen.findByText('Report ID: K7Q2-M9XD')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('errors.report', expect.objectContaining({ message: 'render failed', source: 'boundary' }));
    error.mockRestore();
  });
});
