import { describe, expect, it } from 'vitest';
import { errorText } from './errors';

describe('errorText', () => {
  it('error_text_reads_an_error_message_or_the_value', () => {
    expect(errorText(new Error('It broke.'))).toBe('It broke.');
    expect(errorText('plain')).toBe('plain');
  });
});
