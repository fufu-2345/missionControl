import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import FileViewer from '../components/FileViewer.jsx';
import SkillEditPanel from '../components/SkillEditPanel.jsx';

export default function SkillPage() {
  const { id } = useParams();
  const { user, isAdmin } = useAuth();

  const [skill, setSkill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Master lists for the edit panel (loaded only if the viewer can edit).
  const [tags, setTags] = useState([]);
  const [categories, setCategories] = useState([]);

  // Open file + its content.
  const [activePath, setActivePath] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileContent, setFileContent] = useState('');

  // Edit-mode toggle + the editable draft of the open file.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingFile, setSavingFile] = useState(false);
  const [fileSaveError, setFileSaveError] = useState('');

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  // Owner OR admin may edit. owner.id comes from the detail response;
  // user.id / isAdmin come from the auth context.
  const canEdit = Boolean(skill && user && (user.id === skill.owner?.id || isAdmin));

  const fetchSkill = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/skills/${id}`);
      setSkill(data);
    } catch (err) {
      setError(err.message || 'Failed to load skill.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchSkill();
  }, [fetchSkill]);

  // Load master lists once we know the viewer can edit.
  useEffect(() => {
    if (!canEdit) return;
    (async () => {
      try {
        const [tagData, catData] = await Promise.all([
          apiFetch('/tags'),
          apiFetch('/categories'),
        ]);
        setTags(Array.isArray(tagData?.tags) ? tagData.tags : []);
        setCategories(Array.isArray(catData?.categories) ? catData.categories : []);
      } catch {
        // Non-fatal: editor degrades to file editing only.
      }
    })();
  }, [canEdit]);

  // Open a file: fetch its content and seed the edit draft.
  async function openFile(path) {
    setActivePath(path);
    setFileLoading(true);
    setFileContent('');
    setFileSaveError('');
    try {
      const data = await apiFetch(`/skills/${id}/file?path=${encodeURIComponent(path)}`);
      const content = typeof data?.content === 'string' ? data.content : '';
      setFileContent(content);
      setDraft(content);
    } catch (err) {
      setFileContent('');
      setFileSaveError(err.message || 'Failed to load file.');
    } finally {
      setFileLoading(false);
    }
  }

  // Save the open file's content (owner/admin only).
  async function saveFile() {
    if (!activePath) return;
    setSavingFile(true);
    setFileSaveError('');
    try {
      await apiFetch(`/skills/${id}/file`, {
        method: 'PUT',
        body: { path: activePath, content: draft },
      });
      setFileContent(draft);
    } catch (err) {
      setFileSaveError(err.message || 'Save failed.');
    } finally {
      setSavingFile(false);
    }
  }

  // Save metadata (tags/category/visibility/name), then refetch the detail.
  async function saveMeta(payload) {
    await apiFetch(`/skills/${id}`, { method: 'PATCH', body: payload });
    await fetchSkill();
  }

  // Download the whole skill as <name>.zip. A plain <a href> can't carry the
  // Bearer token, so we fetch with the Authorization header, read the blob, and
  // trigger a download via an object URL.
  async function downloadZip() {
    setDownloading(true);
    setDownloadError('');
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`/api/skills/${id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        throw new Error(`Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `${skill?.name || 'skill'}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setDownloadError(err.message || 'Download failed.');
    } finally {
      setDownloading(false);
    }
  }

  if (loading) {
    return (
      <section className="page">
        <p className="muted">Loading skill…</p>
      </section>
    );
  }

  if (error || !skill) {
    return (
      <section className="page">
        <h1>Skill</h1>
        <p className="auth-error">{error || 'Skill not found.'}</p>
      </section>
    );
  }

  const isInternal = skill.type === 'internal';
  const skillTags = Array.isArray(skill.tags) ? skill.tags : [];

  return (
    <section className="page">
      <div className="page-header">
        <h1>{skill.name}</h1>
        <div className="detail-actions">
          {canEdit && (
            <button
              type="button"
              className="btn"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? 'Done editing' : 'Edit'}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={downloadZip}
            disabled={downloading}
          >
            {downloading ? 'Preparing…' : 'Download .zip'}
          </button>
        </div>
      </div>

      {downloadError && <p className="auth-error">{downloadError}</p>}

      {/* ---- Metadata summary ---- */}
      <div className="detail-meta">
        <span className={`badge ${isInternal ? 'badge-internal' : 'badge-external'}`}>
          {skill.type}
        </span>
        {skill.owner?.username && <span className="muted">by {skill.owner.username}</span>}
        {skill.category && <span className="muted">· {skill.category}</span>}
        <span className="muted">· {skill.visibility}</span>
        <span className="muted">· ⭐ {skill.starCount ?? 0}</span>
      </div>

      {skillTags.length > 0 && (
        <div className="skill-tags detail-tags">
          {skillTags.map((tag) => (
            <span key={tag} className="tag-chip">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* ---- Edit metadata panel (owner/admin only, in edit mode) ---- */}
      {canEdit && editing && (
        <SkillEditPanel
          skill={skill}
          allTags={tags}
          allCategories={categories}
          onSave={saveMeta}
        />
      )}

      {/* ---- File tree + viewer ---- */}
      <h2 className="detail-section-title">Files</h2>
      <FileViewer
        files={skill.files}
        activePath={activePath}
        onSelect={openFile}
        loading={fileLoading}
        content={fileContent}
        canEdit={canEdit && editing}
        draft={draft}
        onDraftChange={setDraft}
        onSave={saveFile}
        saving={savingFile}
        saveError={fileSaveError}
      />
    </section>
  );
}
