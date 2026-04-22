import { OrgNodeService } from './org-node.service';

jest.mock('../../common/tenant-context', () => ({
  TenantContext: { current: () => ({ id: 'tenant-1' }) },
}));

describe('OrgNodeService.addMember', () => {
  it('demotes any existing primary for the person before upserting the new primary', async () => {
    const calls: string[] = [];

    const fakeSupabase = {
      admin: {
        from: (table: string) => {
          calls.push(`from:${table}`);
          return {
            update: (patch: Record<string, unknown>) => {
              calls.push(`update:${JSON.stringify(patch)}`);
              return {
                eq: () => ({
                  eq: () => ({
                    eq: () => Promise.resolve({ error: null }),
                  }),
                }),
              };
            },
            upsert: (row: { is_primary: boolean }) => {
              calls.push(`upsert:is_primary=${row.is_primary}`);
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: { ...row, id: 'mem-1' },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      },
    } as unknown as ConstructorParameters<typeof OrgNodeService>[0];

    const service = new OrgNodeService(fakeSupabase);
    const result = await service.addMember('node-1', 'person-1', true);

    expect(calls).toEqual([
      'from:person_org_memberships',
      'update:{"is_primary":false}',
      'from:person_org_memberships',
      'upsert:is_primary=true',
    ]);
    expect(result).toMatchObject({ id: 'mem-1', is_primary: true });
  });

  it('skips the demote step when adding as non-primary', async () => {
    const calls: string[] = [];
    const fakeSupabase = {
      admin: {
        from: (table: string) => {
          calls.push(`from:${table}`);
          return {
            upsert: (row: { is_primary: boolean }) => {
              calls.push(`upsert:is_primary=${row.is_primary}`);
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: { ...row, id: 'mem-2' },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      },
    } as unknown as ConstructorParameters<typeof OrgNodeService>[0];

    const service = new OrgNodeService(fakeSupabase);
    await service.addMember('node-1', 'person-1', false);

    expect(calls).toEqual([
      'from:person_org_memberships',
      'upsert:is_primary=false',
    ]);
  });
});
