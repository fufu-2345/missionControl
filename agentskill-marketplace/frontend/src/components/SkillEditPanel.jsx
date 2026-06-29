import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';

// Metadata editor shown to owners/admins on the skill detail page.
// Lets them rename the skill, pick a single category, multi-select tags, and
// toggle public/private. When private, also lets them pick which groups can see
// the skill. Saves via PATCH /skills/:id {name, category_id, tag_ids, visibility, groups}.
//
// Props:
//   skill        the current skill detail ({name, category(name|null),
//                tags:[name], visibility, groups:[{id,name}]})
//   allTags      [{id, name}] master list
//   allCategories[{id, name}] master list
//   onSave       (payload) => Promise   parent runs the PATCH + refetch
//
// Note: the detail endpoint returns category/tags as NAME strings, while the
// master lists are {id,name}. We map names -> ids to pre-select, and send ids back.
// Groups arrive as {id,name} objects on the detail, so we pre-select by id directly.
export default function SkillEditPanel({ skill, allTags, allCategories, onSave }) {
  const [name, setName] = useState(skill.name || '');
  const [categoryId, setCategoryId] = useState('');
  const [tagIds, setTagIds] = useState([]);
  const [visibility, setVisibility] = useState(skill.visibility || 'public');
  const [groupIds, setGroupIds] = useState([]);

  // Master list of groups for the private-visibility picker (GET /groups).
  const [allGroups, setAllGroups] = useState([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState(0);

  // Re-seed local state whenever the skill or master lists change (e.g. refetch).
  useEffect(() => {
    setName(skill.name || '');
    setVisibility(skill.visibility || 'public');

    const cat = allCategories.find((c) => c.name === skill.category);
    setCategoryId(cat ? String(cat.id) : '');

    const names = new Set(skill.tags || []);
    setTagIds(allTags.filter((t) => names.has(t.name)).map((t) => t.id));

    // Pre-select the skill's current groups (already {id,name} objects).
    setGroupIds(Array.isArray(skill.groups) ? skill.groups.map((g) => g.id) : []);
  }, [skill, allTags, allCategories]);

  // Load the group master list once (auth-only endpoint).
  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch('/groups');
        setAllGroups(Array.isArray(data?.groups) ? data.groups : []);
      } catch {
        // Non-fatal: the group picker simply renders empty.
      }
    })();
  }, []);

  function toggleTag(id) {
    setTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleGroup(id) {
    setGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: name.trim() || skill.name,
        category_id: categoryId ? Number(categoryId) : null,
        tag_ids: tagIds,
        visibility,
        // Only send groups when private; public clears any group links.
        groups: visibility === 'private' ? groupIds : [],
      };
      await onSave(payload);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err.message || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="edit-panel">
      <h3 className="edit-panel-title">Edit metadata</h3>

      <label className="edit-field">
        Name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="edit-field">
        Category
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">— none —</option>
          {allCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="edit-field">
        <span>Tags</span>
        <div className="edit-tags">
          {allTags.length === 0 && <span className="muted">No tags available.</span>}
          {allTags.map((t) => {
            const active = tagIds.includes(t.id);
            return (
              <button
                type="button"
                key={t.id}
                className={`chip ${active ? 'chip-active' : ''}`}
                onClick={() => toggleTag(t.id)}
              >
                {t.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="edit-field">
        <span>Visibility</span>
        <div className="edit-visibility">
          <label className="radio">
            <input
              type="radio"
              name="visibility"
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
            />
            Public
          </label>
          <label className="radio">
            <input
              type="radio"
              name="visibility"
              checked={visibility === 'private'}
              onChange={() => setVisibility('private')}
            />
            Private
          </label>
        </div>
      </div>

      {/* Group picker — only meaningful for private skills. */}
      {visibility === 'private' && (
        <div className="edit-field">
          <span>Groups that can see this private skill</span>
          <div className="edit-tags">
            {allGroups.length === 0 && (
              <span className="muted">No groups available. Ask an admin to create one.</span>
            )}
            {allGroups.map((g) => {
              const active = groupIds.includes(g.id);
              return (
                <button
                  type="button"
                  key={g.id}
                  className={`chip ${active ? 'chip-active' : ''}`}
                  onClick={() => toggleGroup(g.id)}
                >
                  {g.name}
                </button>
              );
            })}
          </div>
          {allGroups.length > 0 && groupIds.length === 0 && (
            <span className="muted">
              No groups selected — only you and admins will see this skill.
            </span>
          )}
        </div>
      )}

      {error && <p className="auth-error">{error}</p>}

      <div className="edit-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save metadata'}
        </button>
        {savedAt > 0 && !saving && !error && <span className="muted edit-saved">Saved.</span>}
      </div>
    </div>
  );
}
