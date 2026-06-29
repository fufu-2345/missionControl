import { useMemo } from 'react';

// Renders a flat file list (`files[]` = [{path, size}]) as a clickable tree,
// plus a scrollable <pre> viewer pane for the selected file's content.
//
// Props:
//   files        Array<{path, size}>     flat list, POSIX-style relative paths
//   activePath   string | null           currently-open file
//   onSelect     (path) => void          called when a file row is clicked
//   loading      bool                    file content is being fetched
//   content      string                  current file content (read-only view)
//   canEdit      bool                    show the editable panel instead of <pre>
//   draft        string                  editable content (controlled by parent)
//   onDraftChange(value)                 textarea change handler
//   onSave       () => void              save the current draft
//   saving       bool                    a save is in flight
//   saveError    string                  save error message
export default function FileViewer({
  files,
  activePath,
  onSelect,
  loading,
  content,
  canEdit,
  draft,
  onDraftChange,
  onSave,
  saving,
  saveError,
}) {
  const tree = useMemo(() => buildTree(files || []), [files]);

  return (
    <div className="file-browser">
      <aside className="file-tree" aria-label="File tree">
        {tree.length === 0 ? (
          <p className="muted file-tree-empty">No files.</p>
        ) : (
          <TreeNodes nodes={tree} activePath={activePath} onSelect={onSelect} depth={0} />
        )}
      </aside>

      <div className="file-pane">
        {!activePath && <p className="muted file-pane-empty">Select a file to view its content.</p>}

        {activePath && loading && <p className="muted file-pane-empty">Loading {activePath}…</p>}

        {activePath && !loading && !canEdit && (
          <pre className="file-content" aria-label={`Content of ${activePath}`}>
            {content}
          </pre>
        )}

        {activePath && !loading && canEdit && (
          <div className="file-edit">
            <textarea
              className="file-textarea"
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              spellCheck={false}
              aria-label={`Edit ${activePath}`}
            />
            {saveError && <p className="auth-error">{saveError}</p>}
            <div className="file-edit-actions">
              <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save file'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Render nested tree nodes. Directories are bold labels; files are buttons.
function TreeNodes({ nodes, activePath, onSelect, depth }) {
  return (
    <ul className="file-tree-list" style={{ paddingLeft: depth === 0 ? 0 : '0.85rem' }}>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.type === 'dir' ? (
            <>
              <span className="file-tree-dir">{node.name}/</span>
              <TreeNodes
                nodes={node.children}
                activePath={activePath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            </>
          ) : (
            <button
              type="button"
              className={`file-tree-file ${activePath === node.path ? 'file-tree-active' : ''}`}
              onClick={() => onSelect(node.path)}
              title={node.path}
            >
              {node.name}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// Convert a flat [{path}] list into a nested tree of dir/file nodes.
function buildTree(files) {
  const root = [];

  for (const file of files) {
    const parts = String(file.path).split('/').filter(Boolean);
    let level = root;
    let prefix = '';

    parts.forEach((part, idx) => {
      prefix = prefix ? `${prefix}/${part}` : part;
      const isLeaf = idx === parts.length - 1;

      if (isLeaf) {
        level.push({ type: 'file', name: part, path: file.path });
        return;
      }

      let dir = level.find((n) => n.type === 'dir' && n.name === part);
      if (!dir) {
        dir = { type: 'dir', name: part, path: prefix, children: [] };
        level.push(dir);
      }
      level = dir.children;
    });
  }

  // Dirs before files, each alphabetical.
  const sortNodes = (nodes) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.type === 'dir') sortNodes(n.children);
  };
  sortNodes(root);

  return root;
}
