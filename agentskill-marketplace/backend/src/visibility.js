// Pure visibility resolver — implements design spec §2 (Roles & Visibility).
//
// A viewer U can see skill S if ANY of:
//   1. S.visibility === 'public', OR
//   2. U is the owner (S.owner_id === U.id), OR
//   3. U is admin (U.role === 'admin'), OR
//   4. S.visibility === 'private' AND U belongs to a group linked to S
//      (skill_groups ∩ user_groups is non-empty).
//
// No DB access, no imports — caller resolves group memberships and passes
// them in as arrays of ids.

/**
 * @param {Object}        args
 * @param {?{id:*, role?:string}} args.user           Viewer, or null/undefined for anonymous.
 * @param {{owner_id:*, visibility:string}} args.skill The skill being viewed.
 * @param {Array<*>}      [args.userGroupIds]          Group ids the viewer belongs to.
 * @param {Array<*>}      [args.skillGroupIds]         Group ids that can see this private skill.
 * @returns {boolean}                                  Whether the viewer may see the skill.
 */
export function canSee({ user, skill, userGroupIds = [], skillGroupIds = [] }) {
  // Rule 1: public skills are visible to everyone (incl. anonymous).
  if (skill.visibility === 'public') return true;

  // Remaining rules require an authenticated user.
  if (!user) return false;

  // Rule 2: the owner can always see their own skill.
  if (skill.owner_id === user.id) return true;

  // Rule 3: admins can see anything.
  if (user.role === 'admin') return true;

  // Rule 4: private skill shared with a group the viewer belongs to.
  if (skill.visibility === 'private') {
    const skillSet = new Set(skillGroupIds);
    for (const gid of userGroupIds) {
      if (skillSet.has(gid)) return true;
    }
  }

  return false;
}
