import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { apiFetch } from '../api/client.js';

// Small palette reused across the pie/bar charts.
const PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#475569',
  '#ca8a04',
];

const CHART_HEIGHT = 280;

// Percent label for the pie slices.
function pieLabel(entry) {
  const pct = typeof entry.pct === 'number' ? entry.pct : null;
  if (pct === null) return entry.name;
  return `${entry.name} ${pct}%`;
}

export default function Timeline() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [uploads, setUploads] = useState([]); // [{date, count, cumulative}]
  const [recent, setRecent] = useState([]); // [{id, name, type, owner}]
  const [byCategory, setByCategory] = useState([]); // [{category, count, pct}]
  const [topTags, setTopTags] = useState([]); // [{tag, count}]
  const [intExt, setIntExt] = useState([]); // [{type, count, pct}]

  // Toggle for the uploads chart: 'line' (count + cumulative) vs 'bar' (daily).
  const [uploadsType, setUploadsType] = useState('line');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [u, r, c, t, ie] = await Promise.all([
          apiFetch('/stats/uploads-over-time'),
          apiFetch('/stats/recent'),
          apiFetch('/stats/by-category'),
          apiFetch('/stats/top-tags'),
          apiFetch('/stats/internal-external'),
        ]);
        if (cancelled) return;
        setUploads(Array.isArray(u?.points) ? u.points : []);
        setRecent(Array.isArray(r?.skills) ? r.skills.slice(0, 5) : []);
        setByCategory(Array.isArray(c?.data) ? c.data : []);
        setTopTags(Array.isArray(t?.data) ? t.data.slice(0, 10) : []);
        setIntExt(Array.isArray(ie?.data) ? ie.data : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load chart data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <section className="page">
        <h1>Timeline</h1>
        <p className="muted">Loading charts…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="page">
        <h1>Timeline</h1>
        <p className="auth-error">{error}</p>
      </section>
    );
  }

  return (
    <section className="page">
      <h1>Timeline</h1>

      <div className="chart-grid">
        {/* 1. Uploads over time — line (count + cumulative) / bar (daily) toggle */}
        <div className="chart-card chart-card-wide">
          <div className="chart-card-head">
            <h2 className="chart-title">Uploads over time</h2>
            <button
              type="button"
              className="btn"
              onClick={() =>
                setUploadsType((t) => (t === 'line' ? 'bar' : 'line'))
              }
            >
              {uploadsType === 'line' ? 'Show bars' : 'Show lines'}
            </button>
          </div>
          {uploads.length === 0 ? (
            <p className="chart-empty muted">No uploads yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              {uploadsType === 'line' ? (
                <LineChart data={uploads} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="date" fontSize={12} />
                  <YAxis fontSize={12} allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="count"
                    name="Daily"
                    stroke={PALETTE[0]}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="cumulative"
                    name="Cumulative"
                    stroke={PALETTE[1]}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              ) : (
                <BarChart data={uploads} margin={{ top: 8, right: 16, bottom: 0, left: -8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="date" fontSize={12} />
                  <YAxis fontSize={12} allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" name="Daily" fill={PALETTE[0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          )}
        </div>

        {/* 2. Recent uploads — 5 latest skills as cards/list */}
        <div className="chart-card">
          <div className="chart-card-head">
            <h2 className="chart-title">Recent uploads</h2>
          </div>
          {recent.length === 0 ? (
            <p className="chart-empty muted">No recent uploads.</p>
          ) : (
            <ul className="recent-list">
              {recent.map((s) => (
                <li key={s.id}>
                  <Link to={`/skills/${s.id}`} className="recent-item">
                    <span className="recent-name">{s.name}</span>
                    <span className="recent-meta muted">
                      {s.type && (
                        <span
                          className={`badge ${
                            s.type === 'internal'
                              ? 'badge-internal'
                              : 'badge-external'
                          }`}
                        >
                          {s.type}
                        </span>
                      )}
                      {(s.owner?.username || s.owner) && (
                        <span>
                          by {s.owner?.username || s.owner}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 3. By category — pie with % labels + legend */}
        <div className="chart-card">
          <div className="chart-card-head">
            <h2 className="chart-title">By category</h2>
          </div>
          {byCategory.length === 0 ? (
            <p className="chart-empty muted">No categorized skills yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <PieChart>
                <Pie
                  data={byCategory}
                  dataKey="count"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={(e) => pieLabel({ name: e.category, pct: e.pct })}
                >
                  {byCategory.map((entry, i) => (
                    <Cell key={entry.category} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 4. Top tags — horizontal bar (top 10) */}
        <div className="chart-card">
          <div className="chart-card-head">
            <h2 className="chart-title">Top tags</h2>
          </div>
          {topTags.length === 0 ? (
            <p className="chart-empty muted">No tags yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <BarChart
                data={topTags}
                layout="vertical"
                margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis type="number" fontSize={12} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="tag"
                  width={90}
                  fontSize={12}
                />
                <Tooltip />
                <Bar dataKey="count" name="Skills" fill={PALETTE[4]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* 5. Internal vs external — pie with % */}
        <div className="chart-card">
          <div className="chart-card-head">
            <h2 className="chart-title">Internal vs external</h2>
          </div>
          {intExt.length === 0 ? (
            <p className="chart-empty muted">No skills yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <PieChart>
                <Pie
                  data={intExt}
                  dataKey="count"
                  nameKey="type"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  label={(e) => pieLabel({ name: e.type, pct: e.pct })}
                >
                  {intExt.map((entry) => (
                    <Cell
                      key={entry.type}
                      fill={entry.type === 'internal' ? '#dc2626' : '#111111'}
                    />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </section>
  );
}
