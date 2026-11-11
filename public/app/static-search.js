// Search on the friends' web, in the browser: the dashboard uses SQLite FTS5, a static host has nothing like
// it. Reads /data/search.json (src/export/static-search.ts) and answers like GET /api/search: every word must
// appear (accents and case ignored), notes before transcript, and a word that is nowhere is replaced by the
// closest one the classes do say ("did you mean"), as the server does.
const fold = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

let indexPromise = null;
function loadIndex() {
  if (!indexPromise) {
    indexPromise = fetch('/data/search.json')
      .then((r) => (r.ok ? r.json() : { recs: [], docs: [], vocab: [] }))
      .then((idx) => ({ ...idx, folded: idx.docs.map((d) => fold(d[3])) }));
    indexPromise.catch(() => { indexPromise = null; });
  }
  return indexPromise;
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const clean = (text) => text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '').replace(/[#*_>`$]+/g, '').replace(/\s+/g, ' ').trim();

/** Snippet around the first word, with \u0001…\u0002 around each match (the server's highlight markers). */
function snippet(text, words) {
  const f = fold(text);
  const first = Math.max(0, f.indexOf(words[0]));
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, first + 160);
  let out = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  for (const w of words) {
    const fo = fold(out);
    const pos = fo.indexOf(w);
    if (pos >= 0 && fo.length === out.length) out = `${out.slice(0, pos)}\u0001${out.slice(pos, pos + w.length)}\u0002${out.slice(pos + w.length)}`;
  }
  return out;
}

export async function runStaticSearch(query, { course, recordingId, limit = 60 } = {}) {
  const idx = await loadIndex();
  const words = fold(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return { query, corrected: [], hits: [] };

  const find = (ws) => {
    const hits = [];
    for (let i = 0; i < idx.docs.length && hits.length < limit * 3; i++) {
      const [ri, src, startMs, text] = idx.docs[i];
      const [id, title, recCourse] = idx.recs[ri];
      if (course !== undefined && recCourse !== course) continue;
      if (recordingId !== undefined && id !== recordingId) continue;
      if (!ws.every((w) => idx.folded[i].includes(w))) continue;
      const body = src === 0 ? clean(text) : text;
      hits.push({
        source: src === 0 ? 'notes' : 'transcript',
        recordingId: id,
        recordingTitle: title,
        course: recCourse,
        startMs,
        snippet: snippet(body, ws),
        rank: src === 0 ? -2 : -1,
      });
    }
    return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
  };

  let hits = find(words);
  const corrected = [];
  if (hits.length === 0 && idx.vocab?.length) {
    const fixed = words.map((w) => {
      if (w.length < 4) return w;
      const max = w.length <= 5 ? 1 : 2;
      let best = null;
      for (const term of idx.vocab) {
        const d = levenshtein(w, term, max);
        if (d <= max && (!best || d < best.d)) best = { term, d };
      }
      if (best && best.term !== w) {
        corrected.push({ from: w, to: best.term });
        return best.term;
      }
      return w;
    });
    if (corrected.length) hits = find(fixed);
  }
  return { query, corrected, hits };
}
