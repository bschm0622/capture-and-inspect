// Writes report.html: one row per site with a downscaled preview (linked to
// the full PNG), flagged y-ranges marked on it, and the check results.

import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_W = 260;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function writeReport(dir, run) {
  const rows = run.sites.map((s) => {
    const checks = Object.entries(s.checks || {});
    const marks = [];
    let i = 0;
    for (const [name, c] of checks) {
      if (c.pass) continue;
      i++;
      for (const f of c.flags || []) marks.push({ ...f, label: i, name });
    }
    const scale = s.capture ? PREVIEW_W / s.capture.cssWidth : 0;
    const preview = s.preview
      ? `<a href="${esc(s.png)}"><div class="pv" style="width:${PREVIEW_W}px;height:${Math.round(s.capture.cssHeight * scale)}px">
          <img src="${esc(s.preview)}" width="${PREVIEW_W}">
          ${marks.map((m) => `<div class="mark" style="top:${Math.round(m.y0 * scale)}px;height:${Math.max(3, Math.round((m.y1 - m.y0) * scale))}px" title="${esc(`${m.name}: ${m.y0}-${m.y1}px ${m.note || ''}`)}"><span>${m.label}</span></div>`).join('')}
        </div></a>`
      : '<div class="none">no capture</div>';
    let n = 0;
    const table = checks.map(([name, c]) => {
      const label = c.pass ? '' : ++n;
      return `<tr class="${c.pass ? 'ok' : 'bad'}"><td>${c.pass ? 'pass' : `FAIL ${label}`}</td><td><b>${esc(name)}</b>${c.kind === 'site' ? ' <i>(site)</i>' : ''}<br>${esc(c.detail)}
        ${(c.flags || []).length ? `<ul>${c.flags.slice(0, 12).map((f) => `<li>y ${f.y0}–${f.y1}px: ${esc(f.note)}</li>`).join('')}${c.flags.length > 12 ? `<li>…${c.flags.length - 12} more</li>` : ''}</ul>` : ''}</td></tr>`;
    }).join('');
    const meta = s.error
      ? `<p class="err">FAILED: ${esc(s.error)}</p>`
      : `<p>${s.capture.devWidth}×${s.capture.devHeight}px, ${s.tileCount} tiles at ${esc(s.tileTops.join(', '))}; ${(s.durationMs / 1000).toFixed(0)}s</p>`;
    // What the extension itself reported about the capture.
    const warns = s.warnings == null ? ''
      : s.warnings.length
        ? `<p class="warn">Extension warnings:</p><ul class="warn">${s.warnings.map((w) => `<li><b>${esc(w.kind)}</b> y ${w.y0}–${w.y1}px: ${esc(w.note)}</li>`).join('')}</ul>`
        : '<p>Extension warnings: none</p>';
    return `<section><h2>${esc(s.host)} <small>${esc(s.url)}</small></h2><div class="row">${preview}<div class="res">${meta}${warns}<table>${table}</table></div></div></section>`;
  }).join('\n');

  const failed = run.sites.filter((s) => !s.pass).length;
  const html = `<!doctype html><meta charset="utf-8"><title>Capture regression ${esc(run.startedAt)}</title>
<style>
body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#111;background:#fff}
section{border-top:1px solid #ccc;padding:8px 0}
h2{font-size:16px;margin:4px 0}h2 small{font-weight:normal;color:#666}
.row{display:flex;gap:16px;align-items:flex-start}
.pv{position:relative;border:1px solid #999;flex:none}
.pv img{display:block}
.mark{position:absolute;left:-6px;right:-6px;border:2px solid #e00;background:rgba(255,0,0,.15)}
.mark span{position:absolute;left:-18px;top:-2px;background:#e00;color:#fff;font-size:11px;padding:0 3px}
.res{flex:1;min-width:0}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #eee;padding:4px 6px;vertical-align:top}
tr.bad td:first-child{color:#b00;font-weight:bold;white-space:nowrap}tr.ok td:first-child{color:#070}
ul{margin:2px 0 0 18px;padding:0;color:#444}.err{color:#b00;font-weight:bold}.warn{color:#a60}p.warn{margin-bottom:0}
</style>
<h1>Capture regression run</h1>
<p>Extension: ${esc(run.extension)} · ${esc(run.mode)} Chromium ${esc(run.browserVersion)} · viewport ${run.viewport.width}×${run.viewport.height} @${run.viewport.dpr}x · started ${esc(run.startedAt)} · ${(run.durationMs / 1000).toFixed(0)}s</p>
<p><b>${failed ? `${failed} of ${run.sites.length} sites failed` : `all ${run.sites.length} sites passed`}</b>. Red boxes on a preview mark flagged y-ranges, numbered by failing check.</p>
${rows}`;
  fs.writeFileSync(path.join(dir, 'report.html'), html);
}
