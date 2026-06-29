import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client.js';
import UploadModal from '../components/UploadModal.jsx';

export default function Marketplace() {
  const navigate = useNavigate();

  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showUpload, setShowUpload] = useState(false);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/skills');
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
    } catch (err) {
      setError(err.message || 'Failed to load skills.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  return (
    <section className="page">
      <div className="page-header">
        <h1>Marketplace</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowUpload(true)}
        >
          Upload
        </button>
      </div>

      <p className="muted">
        Filters, ⭐ favorites, and recommendations arrive in Sprint 3.
      </p>

      {loading && <p className="muted">Loading skills…</p>}

      {!loading && error && <p className="auth-error">{error}</p>}

      {!loading && !error && skills.length === 0 && (
        <p className="muted">No skills yet. Upload one to get started.</p>
      )}

      {!loading && !error && skills.length > 0 && (
        <div className="skill-grid">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onClick={() => navigate(`/skills/${skill.id}`)}
            />
          ))}
        </div>
      )}

      {showUpload && (
        <UploadModal
          onUploaded={fetchSkills}
          onClose={() => setShowUpload(false)}
        />
      )}
    </section>
  );
}

function SkillCard({ skill, onClick }) {
  const isInternal = skill.type === 'internal';
  // Per spec: red border for internal, black for external.
  const borderColor = isInternal ? '#dc2626' : '#111111';
  const tags = Array.isArray(skill.tags) ? skill.tags : [];

  return (
    <button
      type="button"
      className="skill-card"
      style={{ borderColor }}
      onClick={onClick}
    >
      <div className="skill-card-top">
        <span className="skill-name">{skill.name}</span>
        <span className={`badge ${isInternal ? 'badge-internal' : 'badge-external'}`}>
          {skill.type}
        </span>
      </div>

      <div className="skill-meta muted">
        {skill.owner?.username && <span>by {skill.owner.username}</span>}
        {skill.category && <span>· {skill.category}</span>}
      </div>

      {tags.length > 0 && (
        <div className="skill-tags">
          {tags.map((tag) => (
            <span key={tag} className="tag-chip">
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
