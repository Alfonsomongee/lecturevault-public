// Grading and picking for the practice exam. Pure functions with no DOM: the same code runs on the student's
// panel and on the friends' web (where the exam is corrected in the browser), and the unit tests import it.

export const KIND_ORDER = ['tf', 'mcq', 'short', 'essay'];
export const KIND_LABELS = { tf: 'Verdadero/Falso', mcq: 'Respuesta múltiple', short: 'Desarrollo breve', essay: 'Desarrollo' };

export const fold = (text) => String(text ?? '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
const words = (text) => fold(text).split(/[^a-z0-9ñ]+/).filter(Boolean);

/**
 * Does the answer cover this key? A key is one or more words; each must show up in the answer, matching on the
 * first letters of long words so "derivada" counts for "derivadas" (a stem, not a full stemmer).
 */
export function covers(answerWords, key) {
  const wanted = words(key);
  if (wanted.length === 0) return false;
  return wanted.every((w) => {
    const stem = w.length >= 7 ? w.slice(0, Math.max(5, w.length - 2)) : w;
    return answerWords.some((a) => (w.length >= 7 ? a.startsWith(stem) : a === w));
  });
}

/**
 * Correct one question. `response` is: tf → true/false; mcq → chosen index; short/essay → the text.
 * Returns { score: 0..1, answered, hits } (hits: for rubric questions, which points were found).
 */
export function gradeQuestion(q, response) {
  if (q.kind === 'tf') {
    if (response !== true && response !== false) return { score: 0, answered: false, hits: [] };
    return { score: response === (q.answer === 'true') ? 1 : 0, answered: true, hits: [] };
  }
  if (q.kind === 'mcq') {
    if (!Number.isInteger(response)) return { score: 0, answered: false, hits: [] };
    return { score: response === Number(q.answer) ? 1 : 0, answered: true, hits: [] };
  }
  const text = String(response ?? '').trim();
  if (!text) return { score: 0, answered: false, hits: (q.rubric || []).map(() => false) };
  const answerWords = words(text);
  const hits = (q.rubric || []).map((item) => item.keys.some((key) => covers(answerWords, key)));
  const score = hits.length ? hits.filter(Boolean).length / hits.length : 0;
  return { score, answered: true, hits };
}

/** A question counts as right from this score (rubric questions are partial). */
export const PASS = 0.6;

/** Total of a graded exam: points out of the number of questions, rounded to a quarter. */
export function totalScore(results) {
  const sum = results.reduce((acc, r) => acc + r.score, 0);
  return Math.round(sum * 4) / 4;
}

/** Ids whose most recent saved result was a fail: what «Repasar las falladas» brings back. */
export function failedIds(attempts) {
  const last = new Map();
  for (const attempt of [...attempts].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    for (const item of attempt.items || []) last.set(item.id, item.score);
  }
  return new Set([...last].filter(([, score]) => score < PASS).map(([id]) => id));
}

/**
 * Choose the questions of an exam. Weighted draw without replacement: what the teacher stressed, what the student
 * failed and what they starred come up more often, but nothing is certain. `rng` is injected for tests.
 */
export function pickQuestions(pool, options = {}, rng = Math.random) {
  const {
    n = 20, kinds = KIND_ORDER, recordings = null, onlyEmphasis = false, onlyFailed = false,
    failed = new Set(), seen = new Set(),
  } = options;
  const eligible = pool.filter((q) =>
    kinds.includes(q.kind) &&
    (!recordings || recordings.has(q.recording_id)) &&
    (!onlyEmphasis || q.emphasis) &&
    (!onlyFailed || failed.has(q.id)));
  const keyed = eligible.map((q) => {
    let weight = 1;
    if (q.origin === 'explicit') weight += 1.5;
    else if (q.emphasis) weight += 1;
    if (failed.has(q.id)) weight += 2;
    else if (!seen.has(q.id)) weight += 0.5;
    if (q.starred) weight += 1;
    // Efraimidis–Spirakis: the larger u^(1/w), the earlier it is drawn
    return { q, key: Math.pow(Math.max(rng(), 1e-9), 1 / weight) };
  });
  keyed.sort((a, b) => b.key - a.key);
  const chosen = keyed.slice(0, n === 'all' ? keyed.length : n).map((k) => k.q);
  // Shown as an exam is: the quick ones first, the long ones last
  return chosen.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}
