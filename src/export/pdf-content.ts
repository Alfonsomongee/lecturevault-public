/**
 * What goes into a PDF of the notes, as Markdown. Pure: the dashboard decides which classes and topics,
 * this decides how a class's text reads inside a chapter, so it can be tested without a browser.
 */

import { fold } from '../utils/text.js';

const FENCE = /^\s*```/;

/** Drop the document title (the first H1): a PDF already writes the class title in its own header. */
export function stripLeadingTitle(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || !/^#\s+\S/.test(lines[first]!)) return markdown.trim();
  return lines.slice(first + 1).join('\n').replace(/^\s*\n/, '').trim();
}

/** Push every title `by` levels down (never past ######), leaving code fences alone. */
export function shiftHeadings(markdown: string, by: number): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) { fenced = !fenced; return line; }
      if (fenced) return line;
      return line.replace(/^(#{1,6})(?=\s)/, (hashes) => '#'.repeat(Math.min(6, hashes.length + by)));
    })
    .join('\n');
}

export interface RangeNotes {
  destination: string;
  markdown: string;
}

/**
 * The theory of one class for a topic chapter: the notes of its theory ranges. A class whose ranges
 * have no text (notes edited by hand, or not rewritten yet) gives its whole notes instead, so nothing
 * the student has is left out of the book.
 */
export function theoryMarkdown(ranges: RangeNotes[], notes: string | null | undefined): string {
  const written = ranges
    .filter((r) => r.destination === 'theory' && r.markdown.trim() && !r.markdown.startsWith('*(Sin voz'))
    .map((r) => r.markdown.trim());
  if (written.length > 0) return written.join('\n\n');
  return notes?.trim() ? shiftHeadings(stripLeadingTitle(notes), 1) : '';
}

/** A file name every browser and file system accepts: "Clase 1. Evaluación y mecanismos" → "Clase-1-Evaluacion-y-mecanismos.pdf". */
export function pdfFileName(title: string): string {
  const slug = fold(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Apuntes'}.pdf`;
}

/** Content-Disposition for a download: an ASCII name for old clients and the real one in UTF-8. */
export function contentDisposition(title: string): string {
  return `attachment; filename="${pdfFileName(title)}"; filename*=UTF-8''${encodeURIComponent(`${title.replace(/[\\/:*?"<>|\s]+/g, ' ').trim()}.pdf`)}`;
}
