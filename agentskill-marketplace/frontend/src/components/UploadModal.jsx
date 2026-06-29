import { useState } from 'react';
import { apiFetch } from '../api/client.js';

// Upload modal with two tabs:
//  - Internal: upload a .zip (multipart). Optional name field.
//  - External: paste a public GitHub URL (JSON body).
// Calls onUploaded() on success so the parent list can refetch.
export default function UploadModal({ onUploaded, onClose }) {
  const [tab, setTab] = useState('internal'); // 'internal' | 'external'

  // internal
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');

  // external
  const [url, setUrl] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  function switchTab(next) {
    if (next === tab) return;
    setTab(next);
    setError('');
    setSuccess('');
  }

  async function handleInternalSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!file) {
      setError('Please choose a .zip file to upload.');
      return;
    }

    setBusy(true);
    try {
      // Build multipart form data. Do NOT set Content-Type — the browser
      // adds the multipart boundary, and apiFetch passes FormData through.
      const formData = new FormData();
      formData.append('file', file);
      if (name.trim()) {
        formData.append('name', name.trim());
      }

      await apiFetch('/skills/internal', { method: 'POST', body: formData });

      setSuccess('Created 1 skill.');
      setFile(null);
      setName('');
      onUploaded?.();
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleExternalSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!url.trim()) {
      setError('Please paste a GitHub repository URL.');
      return;
    }

    setBusy(true);
    try {
      // External upload sends JSON; apiFetch sets the JSON content-type.
      const data = await apiFetch('/skills/external', {
        method: 'POST',
        body: { url: url.trim() },
      });

      const count = data?.count ?? data?.created?.length ?? 0;
      setSuccess(`Created ${count} skill${count === 1 ? '' : 's'}.`);
      setUrl('');
      onUploaded?.();
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        // Click outside the dialog closes it.
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Upload skill">
        <div className="modal-header">
          <h2 className="modal-title">Upload a skill</h2>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={() => onClose?.()}
          >
            ×
          </button>
        </div>

        <div className="tabs">
          <button
            type="button"
            className={`tab ${tab === 'internal' ? 'tab-active' : ''}`}
            onClick={() => switchTab('internal')}
          >
            Internal (.zip)
          </button>
          <button
            type="button"
            className={`tab ${tab === 'external' ? 'tab-active' : ''}`}
            onClick={() => switchTab('external')}
          >
            External (GitHub)
          </button>
        </div>

        {error && <p className="auth-error">{error}</p>}
        {success && <p className="modal-success">{success}</p>}

        {tab === 'internal' ? (
          <form className="modal-form" onSubmit={handleInternalSubmit}>
            <label>
              Skill .zip
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            <label>
              Name (optional)
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Defaults to the folder name"
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Uploading…' : 'Upload'}
            </button>
          </form>
        ) : (
          <form className="modal-form" onSubmit={handleExternalSubmit}>
            <label>
              GitHub repository URL
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
              />
            </label>
            <p className="muted modal-hint">
              Public repos only. Each folder containing a SKILL.md becomes a skill.
            </p>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Cloning…' : 'Import'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
