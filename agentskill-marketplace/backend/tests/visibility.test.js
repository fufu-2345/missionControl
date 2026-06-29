import { describe, it, expect } from 'vitest';
import { canSee } from '../src/visibility.js';

// Convenience builders.
const publicSkill = (owner_id = 1) => ({ owner_id, visibility: 'public' });
const privateSkill = (owner_id = 1) => ({ owner_id, visibility: 'private' });

describe('canSee — spec §2 visibility rule', () => {
  describe('Rule 1: public skills', () => {
    it('public skill is visible to its owner', () => {
      const user = { id: 1, role: 'user' };
      expect(canSee({ user, skill: publicSkill(1) })).toBe(true);
    });

    it('public skill is visible to a non-owner user', () => {
      const user = { id: 2, role: 'user' };
      expect(canSee({ user, skill: publicSkill(1) })).toBe(true);
    });

    it('public skill is visible to an anonymous viewer (user=null)', () => {
      expect(canSee({ user: null, skill: publicSkill(1) })).toBe(true);
    });

    it('public skill is visible even with no group info supplied', () => {
      const user = { id: 5, role: 'user' };
      expect(
        canSee({ user, skill: publicSkill(1), userGroupIds: [], skillGroupIds: [] }),
      ).toBe(true);
    });
  });

  describe('Rule 2: owner sees own private skill', () => {
    it('owner sees their own private skill', () => {
      const user = { id: 1, role: 'user' };
      expect(canSee({ user, skill: privateSkill(1) })).toBe(true);
    });

    it('owner sees own private skill even with no shared groups', () => {
      const user = { id: 1, role: 'user' };
      expect(
        canSee({ user, skill: privateSkill(1), userGroupIds: [], skillGroupIds: [9] }),
      ).toBe(true);
    });
  });

  describe('Rule 3: admin sees any private skill', () => {
    it('admin sees a private skill owned by someone else', () => {
      const admin = { id: 99, role: 'admin' };
      expect(canSee({ user: admin, skill: privateSkill(1) })).toBe(true);
    });

    it('admin sees a private skill with no group overlap', () => {
      const admin = { id: 99, role: 'admin' };
      expect(
        canSee({ user: admin, skill: privateSkill(1), userGroupIds: [], skillGroupIds: [3] }),
      ).toBe(true);
    });
  });

  describe('Rule 4: group membership on private skills', () => {
    it('group member sees private skill when groups intersect', () => {
      const user = { id: 2, role: 'user' };
      expect(
        canSee({
          user,
          skill: privateSkill(1),
          userGroupIds: [10, 20],
          skillGroupIds: [20, 30],
        }),
      ).toBe(true);
    });

    it('member sees private skill when there is exactly one shared group', () => {
      const user = { id: 2, role: 'user' };
      expect(
        canSee({
          user,
          skill: privateSkill(1),
          userGroupIds: [7],
          skillGroupIds: [7],
        }),
      ).toBe(true);
    });

    it('non-member does NOT see private skill (disjoint groups)', () => {
      const user = { id: 2, role: 'user' };
      expect(
        canSee({
          user,
          skill: privateSkill(1),
          userGroupIds: [10, 20],
          skillGroupIds: [30, 40],
        }),
      ).toBe(false);
    });

    it('user with no groups does NOT see another user’s private skill', () => {
      const user = { id: 2, role: 'user' };
      expect(
        canSee({
          user,
          skill: privateSkill(1),
          userGroupIds: [],
          skillGroupIds: [10, 20],
        }),
      ).toBe(false);
    });

    it('user with groups does NOT see a private skill shared with no groups', () => {
      const user = { id: 2, role: 'user' };
      expect(
        canSee({
          user,
          skill: privateSkill(1),
          userGroupIds: [10, 20],
          skillGroupIds: [],
        }),
      ).toBe(false);
    });
  });

  describe('Anonymous viewer (user=null)', () => {
    it('anonymous sees public skills', () => {
      expect(canSee({ user: null, skill: publicSkill(1) })).toBe(true);
    });

    it('anonymous does NOT see a private skill', () => {
      expect(canSee({ user: null, skill: privateSkill(1) })).toBe(false);
    });

    it('anonymous does NOT see a private skill even with skill groups set', () => {
      expect(
        canSee({
          user: null,
          skill: privateSkill(1),
          userGroupIds: [10],
          skillGroupIds: [10],
        }),
      ).toBe(false);
    });

    it('undefined user is treated as anonymous', () => {
      expect(canSee({ user: undefined, skill: privateSkill(1) })).toBe(false);
    });
  });

  describe('Default parameters', () => {
    it('omitting userGroupIds/skillGroupIds defaults to empty (no overlap)', () => {
      const user = { id: 2, role: 'user' };
      expect(canSee({ user, skill: privateSkill(1) })).toBe(false);
    });
  });

  describe('ID type matching', () => {
    it('matches owner by strict id equality', () => {
      const user = { id: 1, role: 'user' };
      // owner_id is the same numeric id -> owner rule applies.
      expect(canSee({ user, skill: privateSkill(1) })).toBe(true);
      // different id -> owner rule does not apply.
      expect(canSee({ user, skill: privateSkill(2) })).toBe(false);
    });
  });
});
