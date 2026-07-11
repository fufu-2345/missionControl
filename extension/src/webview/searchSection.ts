import {
  getConfig,
  getHealth,
  getStats,
  indexStatus,
} from "../commands/oracleVectorClient";
import { readIntent, reconcile, type SearchViewModel } from "../commands/searchOps";

// Host-side of the "Search / Oracle" section. Owns the section's CSS/HTML/JS
// (returned as strings that settings.ts injects into its page) and the async
// state builder. The client script is a plain string with NO backtick / NO
// backslash — it is injected verbatim into the webview and would corrupt if it
// contained either (see the note in settings.ts).

/** Sum indexed-doc counts from /api/vector/stats, defensively across shapes. */
export function docsFromStats(stats: any): number {
  if (!stats || typeof stats !== "object") return 0;
  let total = 0;
  const add = (v: any) => {
    if (v && typeof v.count === "number") total += v.count;
  };
  if (Array.isArray(stats.models)) stats.models.forEach(add);
  else for (const k of Object.keys(stats)) add(stats[k]);
  return total;
}

/** Normalize /api/vector/index/status into the view-model index block. */
export function indexFromStatus(s: any): SearchViewModel["index"] {
  if (!s || typeof s !== "object") return { status: "idle", current: 0, total: 0, eta: 0 };
  return {
    status: typeof s.status === "string" ? s.status : "idle",
    current: Number(s.current) || 0,
    total: Number(s.total) || 0,
    eta: Number(s.eta) || 0,
  };
}

/** Fetch everything the section needs and reconcile into a view model. */
export async function buildSearchState(): Promise<SearchViewModel> {
  const { online, config } = await getConfig();
  const intent = readIntent();
  if (!online) {
    return reconcile({ online: false, config: null, health: null, docs: 0, index: indexFromStatus(null), intent });
  }
  const [health, stats, idx] = await Promise.all([getHealth(), getStats(), indexStatus()]);
  return reconcile({
    online: true,
    config,
    health,
    docs: docsFromStats(stats),
    index: indexFromStatus(idx),
    intent,
  });
}

export function searchSectionStyle(): string {
  return [
    ".so-wrap{max-width:820px;margin-bottom:26px}",
    ".so-wrap h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;opacity:.6;margin:0 0 10px}",
    ".so-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}",
    ".so-dot{font-size:11.5px;opacity:.75}",
    ".so-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 14px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));border-radius:8px;margin-bottom:8px;background:var(--vscode-list-hoverBackground,rgba(128,128,128,.06))}",
    ".so-rl{font-size:14px;font-weight:600}",
    ".so-rh{font-size:11.5px;opacity:.66;margin-top:3px}",
    ".so-sub{margin-left:14px;padding-left:14px;border-left:2px solid var(--vscode-panel-border,rgba(128,128,128,.25))}",
    ".so-disabled{opacity:.4;pointer-events:none}",
    // sliding on/off switch
    ".so-switch{position:relative;width:64px;height:26px;border-radius:999px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));background:var(--vscode-input-background);cursor:pointer}",
    ".so-switch .kn{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--vscode-foreground);opacity:.7;transition:left .16s ease}",
    ".so-switch.on{border-color:var(--vscode-charts-green,#3fb950);background:rgba(63,185,80,.18)}",
    ".so-switch.on .kn{left:40px;background:var(--vscode-charts-green,#3fb950);opacity:1}",
    // segmented slide (2 cells)
    ".so-seg{display:inline-flex;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));border-radius:8px;overflow:hidden}",
    ".so-seg button{background:transparent;color:var(--vscode-foreground);border:0;padding:6px 16px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}",
    ".so-seg button.sel{background:var(--vscode-focusBorder);color:#fff}",
    ".so-model{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:12.5px}",
    ".so-badge{font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:8px}",
    ".so-badge.ok{background:rgba(63,185,80,.18);color:var(--vscode-charts-green,#3fb950)}",
    ".so-badge.warn{background:var(--vscode-charts-orange,#d18616);color:#1a1a1a}",
    ".so-btn{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600;font-family:inherit;margin-left:6px}",
    ".so-btn:hover{border-color:var(--vscode-focusBorder)}",
    ".so-status{font-size:12px;opacity:.8;margin-top:8px}",
    ".so-note{font-size:11.5px;opacity:.7;margin-top:8px;color:var(--vscode-charts-orange,#d18616)}",
    ".so-off{font-size:12.5px;opacity:.7;padding:12px 0}",
  ].join("\n");
}

export function searchSectionBody(): string {
  return '<section class="so-wrap" id="search-oracle"><div class="so-off">กำลังโหลดสถานะ Search / Oracle…</div></section>';
}

// NOTE: plain string, NO backtick / NO backslash anywhere below.
const _script = [
  "(function(){",
  "  var vs = window.__mcVscode;",
  "  function esc(s){s=String(s==null?'':s);return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}",
  "  function post(t,extra){var m={type:t};if(extra){for(var k in extra){m[k]=extra[k];}}vs.postMessage(m);}",
  "  function modelRow(m){",
  "    var badge = m.status==='ready' ? '<span class=\"so-badge ok\">ready</span>' : '<span class=\"so-badge warn\">'+esc(m.status)+'</span>';",
  "    var btns = '<span><button class=\"so-btn\" data-so=\"install\" data-model=\"'+esc(m.key)+'\">Install</button>'",
  "      + '<button class=\"so-btn\" data-so=\"choose\" data-model=\"'+esc(m.key)+'\">Choose file</button></span>';",
  "    var pick = m.primary ? '<b>'+esc(m.label)+'</b>' : '<a href=\"#\" data-so=\"model\" data-model=\"'+esc(m.key)+'\">'+esc(m.label)+'</a>';",
  "    return '<div class=\"so-model\"><span>'+pick+' '+badge+(m.reason?' <span style=\"opacity:.6\">'+esc(m.reason)+'</span>':'')+'</span>'+(m.status==='ready'?'':btns)+'</div>';",
  "  }",
  "  function render(v){",
  "    var el = document.getElementById('search-oracle'); if(!el) return;",
  "    if(!v.oracleOnline){ el.innerHTML = '<h2>Search / Oracle</h2><div class=\"so-off\">Oracle offline (:47778) — เปิด oracle server ก่อนถึงจะตั้งค่าได้</div>'; return; }",
  "    var sw = '<div class=\"so-switch'+(v.hybridEnabled?' on':'')+'\" data-so=\"hybrid\" data-next=\"'+(v.hybridEnabled?'0':'1')+'\"><div class=\"kn\"></div></div>';",
  "    var seg = '<div class=\"so-seg\"><button data-so=\"mode\" data-mode=\"vector\" class=\"'+(v.mode==='vector'?'sel':'')+'\">Vector</button>'",
  "      + '<button data-so=\"mode\" data-mode=\"graph\" class=\"'+(v.mode==='graph'?'sel':'')+'\">Graph</button></div>';",
  "    var models = v.models.map(modelRow).join('');",
  "    var pct = v.index.total>0 ? Math.round(100*v.index.current/v.index.total) : 0;",
  "    var indexing = v.index.status==='indexing';",
  "    var statusLine = indexing ? ('Indexing… '+v.index.current+'/'+v.index.total+' ('+pct+'%)') : (v.readiness.ready ? ('พร้อม · '+v.docs+' docs') : ('ยังไม่พร้อม: '+esc(v.readiness.reason||'ยังไม่ได้ index')));",
  "    var idxBtn = indexing ? '<button class=\"so-btn\" data-so=\"stop\">Stop</button>' : '<button class=\"so-btn\" data-so=\"index\">Index now</button>';",
  "    var sub = '<div class=\"so-sub'+(v.hybridEnabled?'':' so-disabled')+'\">'",
  "      + '<div class=\"so-row\"><div><div class=\"so-rl\">Mode</div><div class=\"so-rh\">Vector: FTS5 + LanceDB vector · Graph: coming soon (=FTS5)</div></div>'+seg+'</div>'",
  "      + '<div class=\"so-row\"><div><div class=\"so-rl\">Embedding model</div><div class=\"so-rh\">BGE-M3 = default</div>'+models+'</div></div>'",
  "      + '<div class=\"so-status\">'+esc(statusLine)+' '+idxBtn+'</div>'"
  ,
  "      + (v.modelPath?'<div class=\"so-rh\">model path: '+esc(v.modelPath)+'</div>':'')",
  "      + '</div>';",
  "    var note = v.envOverrideNote ? '<div class=\"so-note\">'+esc(v.envOverrideNote)+'</div>' : '';",
  "    el.innerHTML = '<h2>Search / Oracle</h2>'",
  "      + '<div class=\"so-row\"><div><div class=\"so-rl\">Hybrid search</div><div class=\"so-rh\">ปิด = FTS5 อย่างเดียว · เปิด = ค้นแบบ hybrid</div></div>'+sw+'</div>'",
  "      + sub + note;",
  "  }",
  "  document.addEventListener('click', function(e){",
  "    var t = e.target; if(!t) return;",
  "    var host = t.closest ? t.closest('[data-so]') : null; if(!host) return;",
  "    var act = host.getAttribute('data-so');",
  "    if(act==='hybrid') post('searchSet',{field:'hybrid',value:host.getAttribute('data-next')==='1'});",
  "    else if(act==='mode') post('searchSet',{field:'mode',value:host.getAttribute('data-mode')});",
  "    else if(act==='model'){ e.preventDefault(); post('searchSet',{field:'model',value:host.getAttribute('data-model')}); }",
  "    else if(act==='index') post('indexStart',{});",
  "    else if(act==='stop') post('indexStop',{});",
  "    else if(act==='install') post('installModel',{model:host.getAttribute('data-model')});",
  "    else if(act==='choose') post('chooseModelFile',{model:host.getAttribute('data-model')});",
  "  });",
  "  window.addEventListener('message', function(ev){ var m=ev.data; if(m && m.type==='searchState'){ render(m.state); } });",
  "  post('reloadSearch');",
  "})();",
].join("\n");

export function searchSectionScript(): string {
  return _script;
}
