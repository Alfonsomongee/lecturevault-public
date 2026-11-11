/**
 * The executive summary already written inside a class's notes, so views can lead with it without
 * another model call. Pure: it reads whatever the notes say, generated or edited by hand.
 */

const HEADING = /^#{1,6}\s+/;
const SUMMARY_HEADING = /^#{1,4}\s+(?:\d+[.)]\s*)?.*\bresumen\b/i;
const MIN_FALLBACK_CHARS = 80;
const MAX_SUMMARY_CHARS = 1200;

/** Plain sentence text: no timestamps, emphasis or list markers. Math ($…$) is kept for the renderer. */
function plain(lines: string[]): string {
  return lines
    .map((l) => l.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ''))
    .join(' ')
    .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The body of the "Resumen" section; without one, the first real paragraph; '' if neither exists. */
export function extractSummary(markdown: string | null | undefined): string {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => SUMMARY_HEADING.test(l));
  if (start >= 0) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => HEADING.test(l));
    const body = plain(end >= 0 ? rest.slice(0, end) : rest);
    if (body) return body.slice(0, MAX_SUMMARY_CHARS);
  }
  const paragraphs = markdown.split(/\r?\n\s*\r?\n/).filter((p) => !HEADING.test(p.trim()));
  const first = paragraphs.map((p) => plain(p.split(/\r?\n/))).find((p) => p.length >= MIN_FALLBACK_CHARS);
  return first ? first.slice(0, MAX_SUMMARY_CHARS) : '';
}

const KEY_POINTS_HEADING = /^#{1,4}\s+Puntos clave\s*$/i;

/** The bullets of the "Puntos clave" section: their text without time marks, and the minute of the last mark (null without one). */
export function extractKeyPoints(markdown: string | null | undefined): { text: string; t_ms: number | null }[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => KEY_POINTS_HEADING.test(l));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => HEADING.test(l));
  const points: { text: string; t_ms: number | null }[] = [];
  for (const line of end >= 0 ? rest.slice(0, end) : rest) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const marks = [...bullet[1]!.matchAll(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g)];
    const last = marks[marks.length - 1];
    const seconds = last ? (last[3] !== undefined ? +last[1]! * 3600 + +last[2]! * 60 + +last[3] : +last[1]! * 60 + +last[2]!) : null;
    const text = bullet[1]!.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '').replace(/\*\*|__/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s+/g, ' ').trim();
    if (text) points.push({ text, t_ms: seconds === null ? null : seconds * 1000 });
  }
  return points;
}

/** One line for a list: the first sentence, cut at a word when it is too long. */
export function summaryLine(summary: string, max = 170): string {
  if (!summary) return '';
  const sentence = /^.+?[.!?](?=\s|$)/.exec(summary)?.[0] ?? summary;
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, max).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…`;
}

/**
 * The notes open with the title written when they were made (often by the cloud, before the session analysis
 * named the class). The class shows the analysis' title, so the notes' own heading follows it.
 */
export function withClassTitle(markdown: string, title: string | null | undefined): string {
  const name = (title ?? '').trim();
  if (!name || !markdown) return markdown;
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || !/^#\s+\S/.test(lines[first]!)) return markdown;
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  lines[first] = `# ${name}`;
  return lines.join(eol);
}
