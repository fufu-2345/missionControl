import { useParams } from 'react-router-dom';

export default function SkillPage() {
  const { id } = useParams();
  return (
    <section className="page">
      <h1>Skill #{id}</h1>
      <p className="muted">
        File tree, viewer, download, and edit mode coming soon.
      </p>
    </section>
  );
}
