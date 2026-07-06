// Injected on demand for "Inspect element" mode. Lets the user hover/click any
// element, then reads its computed styles into an on-page panel with one-click
// "Copy for AI" (Markdown), "Copy CSS", and "Copy image" (a screenshot of just
// that element). Built for handing an AI exact facts about a UI element.

(() => {
  if (window.__styleInspectorActive) { window.__styleInspector?.reactivate(); return; }
  window.__styleInspectorActive = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const ACCENT = '#2563eb';

  let hover = null;      // element currently under cursor
  let selected = null;   // element locked in
  let picking = true;

  // --- UI elements (all inline-styled, huge z-index, isolated from page CSS) ---
  const box = mk('div', {
    position: 'fixed', zIndex: 2147483646, pointerEvents: 'none',
    border: `2px solid ${ACCENT}`, borderRadius: '2px',
    background: 'rgba(37,99,235,0.08)', display: 'none',
    boxShadow: '0 0 0 1px rgba(255,255,255,0.4)'
  });
  const tip = mk('div', {
    position: 'fixed', zIndex: 2147483646, pointerEvents: 'none', display: 'none',
    background: '#18181b', color: '#fff', font: '600 11px/1.3 -apple-system,sans-serif',
    padding: '4px 7px', borderRadius: '6px', whiteSpace: 'nowrap'
  });
  document.documentElement.appendChild(box);
  document.documentElement.appendChild(tip);

  let panel = null; // built on selection

  // --- picking ---
  function onMove(e) {
    if (!picking) return;
    const el = e.target;
    if (isOurs(el)) { box.style.display = 'none'; tip.style.display = 'none'; return; }
    hover = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block', left: r.left + 'px', top: r.top + 'px',
      width: r.width + 'px', height: r.height + 'px'
    });
    const label = tag(el) + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    tip.textContent = label;
    tip.style.display = 'block';
    const ty = r.top > 24 ? r.top - 22 : r.bottom + 6;
    Object.assign(tip.style, { left: r.left + 'px', top: ty + 'px' });
  }

  function onClick(e) {
    if (isOurs(e.target)) return; // let panel buttons work
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    select(e.target);
  }

  function onKey(e) { if (e.key === 'Escape') teardown(); }

  function select(el) {
    selected = el;
    picking = false;
    box.style.display = 'none'; tip.style.display = 'none';
    buildPanel(el);
  }

  function reactivate() { picking = true; if (panel) panel.remove(); panel = null; }
  window.__styleInspector = { reactivate };

  // --- style extraction ---
  function extract(el) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const box4 = (p) => collapse(['Top', 'Right', 'Bottom', 'Left'].map((s) => cs[p + s]));
    const data = {
      selector: selector(el),
      tag: tag(el),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      size: `${Math.round(r.width)} × ${Math.round(r.height)} px`,
      pos: `${Math.round(r.left)}, ${Math.round(r.top)}`,
      typography: {
        'font-family': cs.fontFamily,
        'font-size': cs.fontSize,
        'font-weight': cs.fontWeight,
        'line-height': cs.lineHeight,
        'letter-spacing': cs.letterSpacing,
        color: hex(cs.color),
        'text-align': cs.textAlign
      },
      box: {
        width: cs.width, height: cs.height,
        padding: box4('padding'), margin: box4('margin'),
        border: border(cs), 'border-radius': cs.borderRadius
      },
      effects: {
        background: bg(cs),
        'box-shadow': cs.boxShadow === 'none' ? 'none' : cs.boxShadow,
        opacity: cs.opacity
      },
      layout: layout(cs),
      html: el.cloneNode(false).outerHTML
    };
    return data;
  }

  function layout(cs) {
    const o = { display: cs.display, position: cs.position };
    if (cs.position !== 'static') o['z-index'] = cs.zIndex;
    if (cs.display.includes('flex') || cs.display.includes('grid')) {
      o['flex-direction'] = cs.flexDirection;
      o['justify-content'] = cs.justifyContent;
      o['align-items'] = cs.alignItems;
      if (cs.gap && cs.gap !== 'normal') o.gap = cs.gap;
    }
    return o;
  }

  // --- panel ---
  function buildPanel(el) {
    const data = extract(el);
    panel = mk('div', {
      position: 'fixed', zIndex: 2147483647, top: '16px', right: '16px',
      width: '340px', maxHeight: 'calc(100vh - 32px)', overflow: 'auto',
      background: '#fff', color: '#18181b', borderRadius: '14px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.22), 0 2px 8px rgba(0,0,0,0.1)',
      font: '13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      padding: '0'
    });
    panel.setAttribute('data-inspector-ui', '1');

    const head = mk('div', {
      display: 'flex', alignItems: 'center', gap: '8px', padding: '14px 16px',
      borderBottom: '1px solid #ececef', position: 'sticky', top: '0', background: '#fff'
    });
    head.appendChild(mk('div', {
      flex: '0 0 auto', width: '26px', height: '26px', borderRadius: '8px',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg,#3b82f6,#2563eb)', color: '#fff',
      font: '700 13px monospace'
    }, '{ }'));
    head.appendChild(mk('div', { flex: '1', fontWeight: '700', fontSize: '13px',
      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, data.tag));
    const close = mk('div', { cursor: 'pointer', color: '#71717a', fontSize: '20px',
      lineHeight: '1', padding: '0 4px', pointerEvents: 'auto' }, '×');
    close.onclick = teardown;
    head.appendChild(close);
    panel.appendChild(head);

    const body = mk('div', { padding: '4px 16px 12px' });
    body.appendChild(kv('Size', `${data.size}   ·   at ${data.pos}`));
    if (data.text) body.appendChild(kv('Text', `"${data.text}"`));
    body.appendChild(section('Typography', data.typography));
    body.appendChild(section('Box', data.box));
    body.appendChild(section('Background & effects', data.effects));
    body.appendChild(section('Layout', data.layout));
    panel.appendChild(body);

    // actions
    const foot = mk('div', {
      display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '12px 16px',
      borderTop: '1px solid #ececef', position: 'sticky', bottom: '0', background: '#fff'
    });
    foot.appendChild(btn('Copy for AI', true, () => copyText(toMarkdown(data), 'Copy for AI')));
    foot.appendChild(btn('Copy CSS', false, () => copyText(toCss(data), 'Copy CSS')));
    foot.appendChild(btn('Copy image', false, () => copyImage(el)));
    foot.appendChild(btn('Pick another', false, () => reactivate()));
    panel.appendChild(foot);

    document.documentElement.appendChild(panel);
  }

  function section(title, obj) {
    const wrap = mk('div', { margin: '10px 0 2px' });
    wrap.appendChild(mk('div', {
      fontSize: '11px', fontWeight: '700', textTransform: 'uppercase',
      letterSpacing: '.04em', color: '#a1a1aa', marginBottom: '4px'
    }, title));
    for (const [k, v] of Object.entries(obj)) {
      if (v == null || v === '' || v === 'none' && k !== 'box-shadow') continue;
      wrap.appendChild(kv(k, v));
    }
    return wrap;
  }

  function kv(k, v) {
    const row = mk('div', { display: 'flex', gap: '10px', padding: '2px 0', alignItems: 'baseline' });
    row.appendChild(mk('div', { flex: '0 0 92px', color: '#71717a', fontSize: '12px' }, k));
    const val = mk('div', {
      flex: '1', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
      fontSize: '12px', wordBreak: 'break-word'
    }, String(v));
    // swatch for colors
    const m = String(v).match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      const sw = mk('span', { display: 'inline-block', width: '11px', height: '11px',
        borderRadius: '3px', border: '1px solid #0002', marginRight: '6px',
        verticalAlign: 'middle', background: v });
      val.prepend(sw);
    }
    row.appendChild(val);
    return row;
  }

  function btn(label, primary, onClick) {
    const b = mk('button', {
      font: '600 12.5px -apple-system,sans-serif', padding: '7px 12px', borderRadius: '9px',
      cursor: 'pointer', border: primary ? 'none' : '1px solid #d4d4d8',
      background: primary ? ACCENT : '#fff', color: primary ? '#fff' : '#18181b',
      pointerEvents: 'auto'
    }, label);
    b.onclick = () => onClick(b);
    return b;
  }

  // --- copy actions ---
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); flashBtn(label, 'Copied!'); }
    catch (e) { flashBtn(label, 'Copy failed'); }
  }

  async function copyImage(el) {
    const canvas = await elementShot(el);
    if (!canvas) { flashBtn('Copy image', 'Failed'); return; }
    canvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flashBtn('Copy image', 'Copied!');
      } catch (e) { flashBtn('Copy image', 'Failed'); }
    }, 'image/png');
  }

  async function elementShot(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(120);
    if (panel) panel.style.visibility = 'hidden';
    box.style.display = 'none';
    await raf(); await sleep(140); await raf();
    let dataUrl = null;
    try { dataUrl = await chrome.runtime.sendMessage({ type: 'captureViewport' }); }
    catch (e) { /* ignore */ }
    if (panel) panel.style.visibility = 'visible';
    if (!dataUrl) return null;
    const img = await loadImg(dataUrl);
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const pad = 0;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
    c.getContext('2d').drawImage(
      img, r.left * dpr - pad, r.top * dpr - pad, r.width * dpr, r.height * dpr,
      0, 0, c.width, c.height);
    return c;
  }

  function flashBtn(label, msg) {
    const b = [...panel.querySelectorAll('button')].find((x) => x.dataset.orig === label || x.textContent === label);
    if (!b) return;
    if (!b.dataset.orig) b.dataset.orig = label;
    b.textContent = msg;
    setTimeout(() => { b.textContent = b.dataset.orig; }, 1200);
  }

  // --- formatting ---
  function toMarkdown(d) {
    const sec = (title, obj) => {
      const lines = Object.entries(obj)
        .filter(([k, v]) => v && v !== 'none' || k === 'box-shadow')
        .map(([k, v]) => `- ${k}: ${v}`);
      return lines.length ? `\n**${title}**\n${lines.join('\n')}` : '';
    };
    return [
      `Here is a UI element I need help with. **[Describe what's wrong here.]**`,
      ``,
      `## \`${d.tag}\``,
      `- selector: \`${d.selector}\``,
      d.text ? `- text: "${d.text}"` : '',
      `- size: ${d.size} (at ${d.pos})`,
      sec('Typography', d.typography),
      sec('Box', d.box),
      sec('Background & effects', d.effects),
      sec('Layout', d.layout),
      ``,
      '```html',
      d.html,
      '```'
    ].filter((x) => x !== '').join('\n');
  }

  function toCss(d) {
    const all = { ...d.typography, ...d.box, ...d.effects, ...d.layout };
    const lines = Object.entries(all)
      .filter(([k, v]) => v && (v !== 'none' || k === 'box-shadow'))
      .map(([k, v]) => `  ${k}: ${v};`);
    return `${d.selector} {\n${lines.join('\n')}\n}`;
  }

  // --- helpers ---
  function mk(tagName, style, text) {
    const n = document.createElement(tagName);
    Object.assign(n.style, style);
    if (text != null) n.textContent = text;
    return n;
  }
  function isOurs(el) { return !!(el && el.closest && el.closest('[data-inspector-ui]')) || el === box || el === tip; }
  function tag(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    return s;
  }
  function selector(el) {
    const parts = [];
    let e = el, depth = 0;
    while (e && e.nodeType === 1 && depth < 4) {
      if (e.id) { parts.unshift(e.tagName.toLowerCase() + '#' + e.id); break; }
      let part = e.tagName.toLowerCase();
      if (e.classList.length) part += '.' + [...e.classList].slice(0, 2).join('.');
      const parent = e.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === e.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      }
      parts.unshift(part);
      e = parent; depth++;
    }
    return parts.join(' > ');
  }
  function collapse(vals) {
    if (vals.every((v) => v === vals[0])) return vals[0];
    return vals.join(' ');
  }
  function border(cs) {
    if (cs.borderTopWidth === '0px' && cs.borderRightWidth === '0px' &&
        cs.borderBottomWidth === '0px' && cs.borderLeftWidth === '0px') return 'none';
    return `${cs.borderTopWidth} ${cs.borderTopStyle} ${hex(cs.borderTopColor)}`;
  }
  function bg(cs) {
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return cs.backgroundImage;
    return hex(cs.backgroundColor);
  }
  function hex(rgb) {
    const m = String(rgb).match(/rgba?\(([^)]+)\)/);
    if (!m) return rgb;
    const p = m[1].split(',').map((s) => s.trim());
    const [r, g, b] = p.map(Number);
    const a = p[3] != null ? Number(p[3]) : 1;
    if (a === 0) return 'transparent';
    const h = (n) => n.toString(16).padStart(2, '0');
    const base = '#' + h(r) + h(g) + h(b);
    return a < 1 ? `${base} (${Math.round(a * 100)}% opacity)` : base;
  }
  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }

  function teardown() {
    picking = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove(); tip.remove();
    if (panel) panel.remove();
    window.__styleInspectorActive = false;
    window.__styleInspector = null;
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
