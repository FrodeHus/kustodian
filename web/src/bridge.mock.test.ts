import { describe, expect, it } from 'vitest';
import { createBridge } from './bridge';
import { createMockTransport } from './bridge.mock';
import type { ArmManagementGroupsAnswer, ArmResourceTypesAnswer, ArmSubscriptionsAnswer } from './wire';

describe('bridge mock', () => {
  it('mock_answers_the_arm_methods_in_the_hosts_shapes', async () => {
    const bridge = createBridge(createMockTransport());

    const subscriptions = await bridge.call<ArmSubscriptionsAnswer>('arm.subscriptions');
    const groups = await bridge.call<ArmManagementGroupsAnswer>('arm.managementGroups');
    const types = await bridge.call<ArmResourceTypesAnswer>('arm.resourceTypes');

    expect(subscriptions.subscriptions.length).toBeGreaterThan(0);
    for (const subscription of subscriptions.subscriptions) {
      expect(Object.keys(subscription)).toEqual(['id', 'name', 'tenantId', 'state']);
    }
    expect(groups.groups[0]).toEqual({ name: 'contoso-platform', displayName: 'Platform' });
    expect(groups.note).toBeUndefined();
    expect(types.types).toContain('microsoft.keyvault/vaults');
  });

  it('mock_settings_carry_the_arg_rows_limit', async () => {
    const bridge = createBridge(createMockTransport());

    const answer = await bridge.call<{ settings: { limits: Record<string, number> } }>('settings.get');

    expect(answer.settings.limits.argRowsPerRun).toBe(50000);
  });
});
