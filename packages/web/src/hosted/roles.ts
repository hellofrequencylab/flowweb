/**
 * Who may do what in a FlowWeb business, for the screens to hide what a role cannot do. The database
 * decides for real (fw_can in migration 0006); this is the same table as hosted/server/accounts.mjs, and
 * probes/ui/people.mjs checks the two agree.
 */
export const ROLES = ['owner', 'admin', 'helper', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export type Action = 'delete' | 'members' | 'machines' | 'rename' | 'control' | 'drafts';

/** Plain words for each role. */
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including people, machines and deleting the business.',
  admin: 'Invites people, adds machines, runs flows and works drafts.',
  helper: 'Works drafts: edits, rewrites, rejects and approves them.',
  viewer: 'Sees everything, changes nothing.',
};

export const ROLE_NAME: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  helper: 'Helper',
  viewer: 'Viewer',
};

const ALLOWED: Record<Action, readonly Role[]> = {
  delete: ['owner'],
  members: ['owner', 'admin'],
  machines: ['owner', 'admin'],
  rename: ['owner', 'admin'],
  control: ['owner', 'admin'],
  drafts: ['owner', 'admin', 'helper'],
};

/** May a member with this role do this action? Unknown roles and actions answer false. */
export function can(role: string | null | undefined, action: string): boolean {
  return ((ALLOWED as Record<string, readonly string[]>)[action] ?? []).includes(String(role));
}

/** Roles a person with `role` may hand out in an invite or a role change. */
export function grantable(role: string | null | undefined): readonly Role[] {
  if (role === 'owner') return ROLES;
  if (role === 'admin') return ['admin', 'helper', 'viewer'];
  return [];
}
