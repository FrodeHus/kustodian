import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorReportsDialog, ErrorReportsExplainer } from './error-reports';

const setErrorReports = vi.hoisted(() => vi.fn());
vi.mock('./settings-writes', () => ({ setErrorReports, openTelemetryDocs: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ErrorReportsDialog', () => {
  it('error_reports_yes_and_no_answer', async () => {
    const answer = { settings: {} };
    setErrorReports.mockResolvedValue(answer);
    const onClose = vi.fn();
    render(<ErrorReportsDialog onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(answer));
    expect(setErrorReports).toHaveBeenCalledWith(true);

    cleanup();
    render(<ErrorReportsDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(setErrorReports).toHaveBeenLastCalledWith(false));
  });

  it('error_reports_escape_closes_unanswered', () => {
    const onClose = vi.fn();
    render(<ErrorReportsDialog onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith();
    expect(setErrorReports).not.toHaveBeenCalled();
  });

  it('error_reports_explainer_says_what_is_and_is_never_sent', () => {
    render(<ErrorReportsExplainer />);
    expect(
      screen.getByText(
        /error types and where in Kustodian’s code they happened, the recent steps before it as codes, the app version and OS/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Never your tenant, account, queries, values, results or error messages/)).toBeTruthy();
  });
});
