// Who may do what in a FlowWeb business (FW-C-083). The database decides for real (fw_can in
// hosted/supabase/migrations/0006_flowweb_accounts.sql); this copy lets the screens hide what a role
// cannot do and the hosted /v1 say why. probes/hosted/accounts.mjs checks the two agree.

export const ROLES = ['owner', 'admin', 'helper', 'viewer'];

/** Plain words for each role, for the Members screen. */
export const ROLE_HELP = {
  owner: 'Everything, including people, machines and deleting the business.',
  admin: 'Invites people, adds machines, runs flows and works drafts.',
  helper: 'Works drafts: edits, rewrites, rejects and approves them.',
  viewer: 'Sees everything, changes nothing.',
};

const ALLOWED = {
  delete: ['owner'],
  members: ['owner', 'admin'],
  machines: ['owner', 'admin'],
  rename: ['owner', 'admin'],
  control: ['owner', 'admin'],
  drafts: ['owner', 'admin', 'helper'],
};

/** May a member with this role do this action? Unknown roles and actions answer false. */
export function can(role, action) {
  return (ALLOWED[action] ?? []).includes(role);
}

/** The action a queued request kind needs: draft changes are 'drafts', everything else 'control'. */
export function actionOfKind(kind) {
  return String(kind).startsWith('draft.') ? 'drafts' : 'control';
}

/** Roles a person with `role` may hand out in an invite or a role change. */
export function grantable(role) {
  if (role === 'owner') return ROLES;
  if (role === 'admin') return ['admin', 'helper', 'viewer'];
  return [];
}
