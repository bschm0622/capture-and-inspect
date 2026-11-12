// Shared by the fixture pages: the page is a stack of 200px bands, band i
// painted the colour bandColour(i) (fixtures.mjs computes the same) with
// lines of text over its left part for texture, and a plain strip at the
// right (x 1250-1388) where a check samples the colour. A band that shows
// the wrong colour there in the capture is content out of place.
window.BAND = 200;
window.bandColour = (i) => [(i * 67 + 40) % 200 + 30, (i * 131 + 90) % 200 + 30, (i * 29 + 150) % 200 + 30];
const WORDS = 'capture stitch tile seam band scroll page window shot canvas overlap header pixel colour row'.split(' ');
window.makeBand = (i) => {
  const el = document.createElement('section');
  const [r, g, b] = bandColour(i);
  el.className = 'band';
  el.style.cssText = `height:${BAND}px;margin:0;padding:8px 0 0 16px;box-sizing:border-box;background:rgb(${r},${g},${b});overflow:hidden;font:15px/22px sans-serif;color:${r + g + b > 380 ? '#111' : '#fafafa'}`;
  const lines = [];
  for (let l = 0; l < 8; l++) {
    let s = `Band ${i} line ${l}:`;
    for (let k = 0; k < 18; k++) s += ' ' + WORDS[(i * 7 + l * 5 + k * 3) % WORDS.length];
    lines.push(`<div style="width:1200px;white-space:nowrap;overflow:hidden">${s}</div>`);
  }
  el.innerHTML = lines.join('');
  return el;
};
// Lines of text over the left part of `el` (x < 1200), for texture: a flat
// region that tall would read as a blank band.
window.addLines = (el, n, color = '#fff') => {
  const box = document.createElement('div');
  box.style.cssText = `position:relative;padding:8px 16px;font:15px/22px sans-serif;color:${color}`;
  for (let l = 0; l < n; l++) {
    let s = `Line ${l}:`;
    for (let k = 0; k < 18; k++) s += ' ' + WORDS[(l * 5 + k * 3) % WORDS.length];
    const d = document.createElement('div');
    d.style.cssText = 'width:1200px;white-space:nowrap;overflow:hidden';
    d.textContent = s;
    box.appendChild(d);
  }
  el.appendChild(box);
};
window.addBands = (parent, from, count) => {
  const frag = document.createDocumentFragment();
  for (let i = from; i < from + count; i++) frag.appendChild(makeBand(i));
  parent.appendChild(frag);
};
