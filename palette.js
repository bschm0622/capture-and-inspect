// Injected on demand for "Extract palette" mode. Scans the page's computed
// styles for every declared color (text, background, gradients, borders,
// shadows, SVG fills), dedupes and ranks them by how often they're used, and
// shows a panel with token-ready exports (hex list, CSS variables, Tailwind).
// Reads *declared* values, not sampled pixels, so you get the site's real
// design tokens rather than anti-aliased averages.

(() => {
  if (window.__palettePanel) { window.__palettePanel.remove(); window.__palettePanel = null; }

  const MAX_ELEMENTS = 20000;
  const ACCENT = '#2563eb';
  const colors = new Map(); // hex -> { count, roles: Map(role->count) }

  function add(raw, role) {
    const hex = toHex(raw);
    if (!hex) return;
    let e = colors.get(hex);
    if (!e) { e = { count: 0, roles: new Map() }; colors.set(hex, e); }
    e.count++;
    e.roles.set(role, (e.roles.get(role) || 0) + 1);
  }

  function scan() {
    const els = document.querySelectorAll('*');
    const n = Math.min(els.length, MAX_ELEMENTS);
    for (let i = 0; i < n; i++) {
      const el = els[i];
      const cs = getComputedStyle(el);
      add(cs.color, 'text');
      add(cs.backgroundColor, 'bg');
      if (cs.borderTopStyle !== 'none') add(cs.borderTopColor, 'border');
      if (cs.borderLeftStyle !== 'none') add(cs.borderLeftColor, 'border');
      // gradient / image color stops
      if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) {
        stops(cs.backgroundImage).forEach((c) => add(c, 'bg'));
      }
      if (cs.boxShadow && cs.boxShadow !== 'none') {
        stops(cs.boxShadow).forEach((c) => add(c, 'shadow'));
      }
      // inline SVG fills/strokes
      if (el.namespaceURI && el.namespaceURI.includes('svg')) {
        add(cs.fill, 'icon');
        add(cs.stroke, 'icon');
      }
    }
    return n;
  }

  // ranked, dropping colors that appear only once (noise) unless very few total
  function ranked() {
    let arr = [...colors.entries()].map(([hex, e]) => ({
      hex, count: e.count,
      role: [...e.roles.entries()].sort((a, b) => b[1] - a[1])[0][0]
    }));
    arr.sort((a, b) => b.count - a.count);
    const solid = arr.filter((c) => c.count > 1);
    return (solid.length >= 6 ? solid : arr).slice(0, 48);
  }

  const scanned = scan();
  const list = ranked();

  // --- panel ---
  const panel = mk('div', {
    position: 'fixed', zIndex: 2147483647, top: '16px', right: '16px',
    width: '320px', maxHeight: 'calc(100vh - 32px)', overflow: 'auto',
    background: '#fff', color: '#18181b', borderRadius: '14px',
    boxShadow: '0 12px 40px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.1)',
    font: '13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
  });
  panel.setAttribute('data-palette-ui', '1');
  window.__palettePanel = panel;

  const head = mk('div', {
    display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px',
    borderBottom: '1px solid #ececef', position: 'sticky', top: '0', background: '#fff'
  });
  head.appendChild(mk('div', {
    flex: '0 0 auto', width: '26px', height: '26px', borderRadius: '8px',
    background: 'conic-gradient(from 0deg,#ef4444,#f59e0b,#10b981,#3b82f6,#8b5cf6,#ef4444)'
  }));
  const htxt = mk('div', { flex: '1' });
  htxt.appendChild(mk('div', { fontWeight: '700', fontSize: '14px' }, 'Palette'));
  htxt.appendChild(mk('div', { fontSize: '11.5px', color: '#71717a' },
    `${list.length} colors · ${scanned.toLocaleString()} elements`));
  head.appendChild(htxt);
  const close = mk('div', { cursor: 'pointer', color: '#71717a', fontSize: '20px', lineHeight: '1', padding: '0 4px' }, '×');
  close.onclick = () => { panel.remove(); window.__palettePanel = null; };
  head.appendChild(close);
  panel.appendChild(head);

  const grid = mk('div', { padding: '10px 12px' });
  for (const c of list) {
    const row = mk('div', {
      display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 6px',
      borderRadius: '8px', cursor: 'pointer'
    });
    row.onmouseenter = () => (row.style.background = '#f4f4f6');
    row.onmouseleave = () => (row.style.background = 'transparent');
    row.onclick = () => copy(c.hex, row, c.hex);
    row.appendChild(mk('div', {
      flex: '0 0 auto', width: '30px', height: '30px', borderRadius: '7px',
      background: c.hex, border: '1px solid rgba(0,0,0,.12)'
    }));
    const meta = mk('div', { flex: '1', minWidth: '0' });
    meta.appendChild(mk('div', {
      fontFamily: 'ui-monospace,Menlo,monospace', fontSize: '12.5px', fontWeight: '600'
    }, c.hex));
    meta.appendChild(mk('div', { fontSize: '11px', color: '#a1a1aa' }, `${c.role} · ${c.count}×`));
    row.appendChild(meta);
    grid.appendChild(row);
  }
  panel.appendChild(grid);

  const foot = mk('div', {
    display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '12px 16px',
    borderTop: '1px solid #ececef', position: 'sticky', bottom: '0', background: '#fff'
  });
  foot.appendChild(btn('Copy hex', true, (b) => copy(hexList(), b, 'Copy hex')));
  foot.appendChild(btn('CSS variables', false, (b) => copy(cssVars(), b, 'CSS variables')));
  foot.appendChild(btn('Tailwind', false, (b) => copy(tailwind(), b, 'Tailwind')));
  panel.appendChild(foot);

  document.documentElement.appendChild(panel);

  // --- exports ---
  function hexList() { return list.map((c) => c.hex).join('\n'); }
  function cssVars() {
    return ':root {\n' + list.map((c, i) => `  --color-${i + 1}: ${c.hex};`).join('\n') + '\n}';
  }
  function tailwind() {
    const body = list.map((c, i) => `        'c${i + 1}': '${c.hex}',`).join('\n');
    return `// tailwind.config.js\ntheme: {\n  extend: {\n    colors: {\n${body}\n    },\n  },\n},`;
  }

  async function copy(text, node, label) {
    try {
      await navigator.clipboard.writeText(text);
      if (node && node.tagName === 'BUTTON') flash(node, label);
      else flashRow(node);
    } catch (e) { /* ignore */ }
  }
  function flash(btnEl, label) {
    if (!btnEl.dataset.orig) btnEl.dataset.orig = label;
    btnEl.textContent = 'Copied!';
    setTimeout(() => (btnEl.textContent = btnEl.dataset.orig), 1100);
  }
  function flashRow(row) {
    const prev = row.style.background;
    row.style.background = '#dcfce7';
    setTimeout(() => (row.style.background = prev), 500);
  }

  // --- helpers ---
  function mk(tag, style, text) {
    const n = document.createElement(tag);
    Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(label, primary, onClick) {
    const b = mk('button', {
      font: '600 12.5px -apple-system,sans-serif', padding: '7px 12px', borderRadius: '9px',
      cursor: 'pointer', border: primary ? 'none' : '1px solid #d4d4d8',
      background: primary ? ACCENT : '#fff', color: primary ? '#fff' : '#18181b'
    }, label);
    b.onclick = () => onClick(b);
    return b;
  }
  function stops(str) {
    const out = [];
    const re = /(#[0-9a-f]{3,8}\b|rgba?\([^)]+\))/gi;
    let m;
    while ((m = re.exec(str))) out.push(m[1]);
    return out;
  }
  function toHex(raw) {
    if (!raw) return null;
    raw = raw.trim();
    if (raw.startsWith('#')) return normHex(raw);
    const m = raw.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,/]/).map((s) => s.trim());
    const r = +p[0], g = +p[1], b = +p[2];
    const a = p[3] != null ? parseFloat(p[3]) : 1;
    if (![r, g, b].every((x) => x >= 0 && x <= 255)) return null;
    if (a === 0) return null; // fully transparent — not a real color
    const h = (x) => Math.round(x).toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b);
  }
  function normHex(h) {
    h = h.toLowerCase();
    if (h.length === 4) return '#' + [...h.slice(1)].map((c) => c + c).join('');
    if (h.length === 9) return h.slice(0, 7); // drop alpha
    if (h.length === 7) return h;
    return null;
  }
})();
