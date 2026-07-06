// Toolbar popup: a launcher for the two tools. "Full-page screenshot" swaps to
// the progress view and drives the scroll-and-stitch capture (progress streamed
// from the service worker). "Inspect element" injects the picker and closes.

const $ = (id) => document.getElementById(id);

function setBar(fraction, indeterminate) {
  const track = $('track');
  if (indeterminate) {
    track.classList.add('indet');
    $('pct').textContent = '';
  } else {
    track.classList.remove('indet');
    $('fill').style.width = Math.max(6, Math.round(fraction * 100)) + '%';
    $('pct').textContent = Math.round(fraction * 100) + '%';
  }
}

function render(msg) {
  switch (msg.phase) {
    case 'prepare':
      $('sub').textContent = 'Loading the whole page…';
      setBar(0, true);
      break;
    case 'tile':
      $('sub').textContent = `Section ${msg.index + 1} of ${msg.total}`;
      setBar((msg.index + 1) / msg.total, false);
      break;
    case 'done':
      $('ico').classList.add('done');
      $('title').textContent = 'Done';
      $('sub').textContent = 'Opening the editor…';
      $('pct').classList.add('done');
      $('fill').classList.add('done');
      $('foot').textContent = 'Saved as ' + (msg.filename || 'screenshot.png');
      setBar(1, false);
      break;
    case 'error':
      $('ico').classList.add('err');
      $('title').textContent = "Couldn't capture";
      $('sub').textContent = msg.error || 'Something went wrong.';
      $('fill').classList.add('err');
      $('foot').textContent = 'Try a normal web page and reload it first.';
      setBar(1, false);
      break;
  }
}

// Listen before starting so we don't miss the first update.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'capture-progress') render(msg);
});

function activeTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => resolve(tab)));
}

$('btnCapture').addEventListener('click', async () => {
  const tab = await activeTab();
  $('launcher').style.display = 'none';
  $('progress').style.display = 'block';
  setBar(0, true);
  chrome.runtime.sendMessage({ type: 'startCapture', tabId: tab && tab.id }, (resp) => {
    void chrome.runtime.lastError;
    if (resp && resp.error === 'A capture is already running.') {
      render({ phase: 'error', error: resp.error });
    }
  });
});

function launchPageTool(type, btnId, failLabel) {
  return async () => {
    const tab = await activeTab();
    chrome.runtime.sendMessage({ type, tabId: tab && tab.id }, (resp) => {
      void chrome.runtime.lastError;
      if (resp && resp.error) {
        $(btnId).querySelector('b').textContent =
          resp.error === 'not-capturable' ? "Can't use this on this page" : failLabel;
        return;
      }
      window.close(); // hand control to the on-page tool
    });
  };
}

$('btnInspect').addEventListener('click', launchPageTool('startInspect', 'btnInspect', 'Inspect failed'));
$('btnPalette').addEventListener('click', launchPageTool('startPalette', 'btnPalette', 'Palette failed'));
