// Tells a bot wall or an error page from the site it stands in front of,
// from what capture.mjs read off the page before capturing it (`gate`) and
// the HTTP status of the page load. A blocked site is reported as
// `blocked`, apart from pass and fail: its capture says nothing about the
// extension.

// Under this much text, with no large image or video and no more than a
// screen tall, a page is a placeholder, not a site.
const THIN_TEXT = 150;
// An error status with this much text or more is still judged by its
// content (a styled 404 page that is the whole site is rare, a site that
// answers 403/503 but serves its full page is not).
const ERROR_TEXT = 1000;

export function gateVerdict(cap, vh = 868) {
  const g = cap.gate;
  const status = cap.http ? cap.http.status : null;
  if (!g || g.error) return { blocked: false, reason: null };
  if (g.markers && g.markers.length) return { blocked: true, reason: `${g.markers.join(', ')}${status ? ` (HTTP ${status})` : ''}` };
  if (status >= 400 && g.textLength < ERROR_TEXT) return { blocked: true, reason: `HTTP ${status}, ${g.textLength} chars of text` };
  if (g.textLength < THIN_TEXT && !g.media && g.height <= vh + 16) return { blocked: true, reason: `almost no content: ${g.textLength} chars of text, no images${status ? `, HTTP ${status}` : ''}` };
  return { blocked: false, reason: null };
}
