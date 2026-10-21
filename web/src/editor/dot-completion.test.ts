import { describe, expect, it } from 'vitest';
import { shouldAsk } from './dot-completion';

describe('shouldAsk', () => {
  it('dot_completion_asks_after_a_name_and_dot_outside_strings_and_comments', () => {
    expect(shouldAsk('applications | extend x = onPremisesPublishing.')).toBe(true);
    expect(shouldAsk('applications\n| mv-expand c = passwordCredentials | where c.')).toBe(true);
    expect(shouldAsk('applications | where displayName == "a.')).toBe(false);
    expect(shouldAsk('// onPremisesPublishing.')).toBe(false);
    expect(shouldAsk('applications | take 1.')).toBe(false);
    expect(shouldAsk('onPremisesPublishing.ext')).toBe(false);
  });
});
