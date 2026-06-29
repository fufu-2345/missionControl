// Shared skill card — used by the Marketplace all-skills grid AND the
// Recommended zone. Per spec: red border for internal, black for external,
// with a ⭐ toggle (top-right) and click→detail navigation.
export default function SkillCard({ skill, onOpen, onStar }) {
  const isInternal = skill.type === 'internal';
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
