import {
  buildStandaloneOrganizationSlug,
  buildStandaloneSourceIdentity,
} from './standalone-organization-provisioning.repository';

describe('buildStandaloneOrganizationSlug', () => {
  it('uses the authenticated user ID instead of the company name', () => {
    expect(buildStandaloneOrganizationSlug('user-1')).toBe('standalone-user-1');
    expect(buildStandaloneOrganizationSlug('user-2')).toBe('standalone-user-2');
  });
});

describe('buildStandaloneSourceIdentity', () => {
  it('uses an internal organization-scoped identity', () => {
    expect(buildStandaloneSourceIdentity('org-1')).toBe('standalone:org-1');
  });
});
