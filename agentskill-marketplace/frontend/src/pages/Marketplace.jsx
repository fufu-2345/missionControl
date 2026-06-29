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

  // Filter master lists.
  const [tags, setTags] = useState([]); // [{id, name}]
  const [categories, setCategories] = useState([]); // [{id, name}]

  // Active filters. Tags/categories are filtered by NAME (the query param the
  // backend expects); starred is a boolean toggle. Tag AND category combine.
  const [activeTag, setActiveTag] = useState(null);
  const [activeCategory, setActiveCategory] = useState(null);
  const [starredOnly, setStarredOnly] = useState(false);

  // Load tag/category filter options once.
  useEffect(() => {
    (async () => {
      try {
        const [tagData, catData] = await Promise.all([
          apiFetch('/tags'),
          apiFetch('/categories'),
        ]);
        setTags(Array.isArray(tagData?.tags) ? tagData.tags : []);
        setCategories(Array.isArray(catData?.categories) ? catData.categories : []);
      } catch {
        // Non-fatal: the grid still works without filter chips.
      }
    })();
  }, []);

  // Refetch the grid whenever a filter changes. Builds ?tag=&category=&starred=.
  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (activeTag) params.set('tag', activeTag);
      if (activeCategory) params.set('category', activeCategory);
      if (starredOnly) params.set('starred', 'true');
      const qs = params.toString();
      const data = await apiFetch(`/skills${qs ? `?${qs}` : ''}`);
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
    } catch (err) {
      setError(err.message || 'Failed to load skills.');
    } finally {
      setLoading(false);
    }
  }, [activeTag, activeCategory, starredOnly]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  // Toggle helpers: clicking the active chip clears it.
  const toggleTag = (name) => setActiveTag((cur) => (cur === name ? null : name));
  const toggleCategory = (name) =>
    setActiveCategory((cur) => (cur === name ? null : name));

  // Star a single card; patch just that card from the response.
  async function handleStar(skillId) {
    try {
      const res = await apiFetch(`/skills/${skillId}/star`, { method: 'POST' });
      setSkills((prev) =>
        prev.map((s) =>
          s.id === skillId
            ? { ...s, starred: res.starred, starCount: res.starCount }
            : s
        )
      );
    } catch (err) {
      setError(err.message || 'Failed to update star.');
    }
  }

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

      {/* Recommended zone (content-based) lands in Sprint 5 — placeholder only. */}

      {/* ---- Filter chips ---- */}
      <div className="filters">
        {tags.length > 0 && (
          <div className="filter-row">
            <span className="filter-label">Tags</span>
            <div className="chip-row">
              {tags.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`chip ${activeTag === t.name ? 'chip-active' : ''}`}
                  onClick={() => toggleTag(t.name)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {categories.length > 0 && (
          <div className="filter-row">
            <span className="filter-label">Categories</span>
            <div className="chip-row">
              {categories.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className={`chip ${activeCategory === c.name ? 'chip-active' : ''}`}
                  onClick={() => toggleCategory(c.name)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="filter-row">
          <button
            type="button"
            className={`chip ${starredOnly ? 'chip-active' : ''}`}
            onClick={() => setStarredOnly((v) => !v)}
          >
            {starredOnly ? '⭐ Starred only' : '☆ Starred only'}
          </button>
        </div>
      </div>

      {loading && <p className="muted">Loading skills…</p>}

      {!loading && error && <p className="auth-error">{error}</p>}

      {!loading && !error && skills.length === 0 && (
        <p className="muted">No skills match these filters.</p>
      )}

      {!loading && !error && skills.length > 0 && (
        <div className="skill-grid">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onOpen={() => navigate(`/skills/${skill.id}`)}
              onStar={() => handleStar(skill.id)}
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

function SkillCard({ skill, onOpen, onStar }) {
  const isInternal = skill.type === 'internal';
  // Per spec: red border for internal, black for external.
  const borderColor = isInternal ? '#dc2626' : '#111111';
  const tags = Array.isArray(skill.tags) ? skill.tags : [];

  return (
    <div
      className="skill-card"
      style={{ borderColor }}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <button
        type="button"
        className="star-btn"
        aria-label={skill.starred ? 'Unstar' : 'Star'}
        onClick={(e) => {
          e.stopPropagation(); // don't navigate
          onStar();
        }}
      >
        {skill.starred ? '⭐' : '☆'}
        {typeof skill.starCount === 'number' && (
          <span className="star-count">{skill.starCount}</span>
        )}
      </button>

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
    </div>
  );
}
