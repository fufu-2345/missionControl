import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';

// Admin console (admin-only route, gated by AdminRoute in App.jsx).
// Three independent sections, each managing its own master list:
//   - Tags        GET /tags        | POST/DELETE /admin/tags
//   - Categories  GET /categories  | POST/DELETE /admin/categories
//   - Groups      GET /admin/groups (with members) | POST/DELETE /admin/groups
//                 + per-group member add/remove against /admin/groups/:id/members
//
// Each action refreshes only the list it touches and surfaces its own error.

export default function Admin() {
  return (
    <section className="page">
      <h1>Admin</h1>
      <p className="muted">Manage tags, categories, groups, and group members.</p>

      <MasterListSection
        title="Tags"
        listPath="/tags"
        listKey="tags"
        createPath="/admin/tags"
        deletePath={(id) => `/admin/tags/${id}`}
        placeholder="New tag name"
      />

      <MasterListSection
        title="Categories"
        listPath="/categories"
        listKey="categories"
        createPath="/admin/categories"
        deletePath={(id) => `/admin/categories/${id}`}
        placeholder="New category name"
      />

      <GroupsSection />
    </section>
  );
}

// ---- Reusable section for flat name-only master lists (tags & categories) ----
function MasterListSection({ title, listPath, listKey, createPath, deletePath, placeholder }) {
  const [items, setItems] = useState([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(listPath);
      setItems(Array.isArray(data?.[listKey]) ? data[listKey] : []);
    } catch (err) {
      setError(err.message || `Failed to load ${title.toLowerCase()}.`);
    } finally {
      setLoading(false);
    }
  }, [listPath, listKey, title]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function add(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(createPath, { method: 'POST', body: { name: trimmed } });
      setName('');
      await refresh();
    } catch (err) {
      setError(err.message || 'Create failed.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id) {
    setBusy(true);
    setError('');
    try {
      await apiFetch(deletePath(id), { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(err.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">{title}</h2>

      <form className="admin-add-row" onSubmit={add}>
        <input
          type="text"
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          Add
        </button>
      </form>

      {error && <p className="auth-error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="admin-list">
          {items.map((item) => (
            <li key={item.id} className="admin-list-row">
              <span>{item.name}</span>
              <button
                type="button"
                className="btn admin-delete"
                onClick={() => remove(item.id)}
                disabled={busy}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Groups section: groups with members + a user picker per group ----
function GroupsSection() {
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshGroups = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/admin/groups');
      setGroups(Array.isArray(data?.groups) ? data.groups : []);
    } catch (err) {
      setError(err.message || 'Failed to load groups.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshGroups();
    // Users are needed for the per-group "add member" picker.
    (async () => {
      try {
        const data = await apiFetch('/admin/users');
        setUsers(Array.isArray(data?.users) ? data.users : []);
      } catch {
        // Non-fatal: group list still works without the picker.
      }
    })();
  }, [refreshGroups]);

  async function createGroup(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch('/admin/groups', { method: 'POST', body: { name: trimmed } });
      setName('');
      await refreshGroups();
    } catch (err) {
      setError(err.message || 'Create failed.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(id) {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/admin/groups/${id}`, { method: 'DELETE' });
      await refreshGroups();
    } catch (err) {
      setError(err.message || 'Delete failed.');
    } finally {
      setBusy(false);
    }
  }

  async function addMember(groupId, userId) {
    setError('');
    try {
      await apiFetch(`/admin/groups/${groupId}/members`, {
        method: 'POST',
        body: { user_id: Number(userId) },
      });
      await refreshGroups();
    } catch (err) {
      setError(err.message || 'Add member failed.');
    }
  }

  async function removeMember(groupId, userId) {
    setError('');
    try {
      await apiFetch(`/admin/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
      await refreshGroups();
    } catch (err) {
      setError(err.message || 'Remove member failed.');
    }
  }

  return (
    <div className="admin-section">
      <h2 className="admin-section-title">Groups</h2>

      <form className="admin-add-row" onSubmit={createGroup}>
        <input
          type="text"
          value={name}
          placeholder="New group name"
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          Create group
        </button>
      </form>

      {error && <p className="auth-error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="muted">No groups yet.</p>
      ) : (
        <div className="admin-groups">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              users={users}
              busy={busy}
              onDelete={() => deleteGroup(group.id)}
              onAddMember={(userId) => addMember(group.id, userId)}
              onRemoveMember={(userId) => removeMember(group.id, userId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupCard({ group, users, busy, onDelete, onAddMember, onRemoveMember }) {
  const [pick, setPick] = useState('');
  const members = Array.isArray(group.members) ? group.members : [];
  const memberIds = new Set(members.map((m) => m.id));
  const available = users.filter((u) => !memberIds.has(u.id));

  function submitAdd(e) {
    e.preventDefault();
    if (!pick) return;
    onAddMember(pick);
    setPick('');
  }

  return (
    <div className="admin-group-card">
      <div className="admin-group-head">
        <strong>{group.name}</strong>
        <button type="button" className="btn admin-delete" onClick={onDelete} disabled={busy}>
          Delete group
        </button>
      </div>

      <div className="admin-group-members">
        {members.length === 0 ? (
          <span className="muted">No members.</span>
        ) : (
          members.map((m) => (
            <span key={m.id} className="member-chip">
              {m.username}
              <button
                type="button"
                className="member-remove"
                title={`Remove ${m.username}`}
                onClick={() => onRemoveMember(m.id)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <form className="admin-add-row" onSubmit={submitAdd}>
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">— add member —</option>
          {available.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
              {u.role === 'admin' ? ' (admin)' : ''}
            </option>
          ))}
        </select>
        <button type="submit" className="btn" disabled={!pick}>
          Add
        </button>
      </form>
    </div>
  );
}
