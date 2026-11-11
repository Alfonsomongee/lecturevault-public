/**
 * Course materials from the campus (pure, testable): what the subject's "Contenido" holds, which files are
 * worth keeping, where they go, and the syllabus its folders spell out.
 *
 * The listing comes from Blackboard Learn's REST API (the same one Ultra calls, with the browser's session:
 * see materials-sync.ts). Only what the student can see is kept, and a file is fetched again only when the
 * campus says it changed.
 */

import { fold } from '../utils/text.js';

/** One item of the Blackboard content tree (the fields this module reads). */
export interface BbContent {
  id: string;
  title?: string;
  parentId?: string;
  created?: string;
  modified?: string;
  hasChildren?: boolean;
  availability?: { available?: string };
  contentHandler?: { id?: string; url?: string; file?: { fileName?: string } };
}

export interface BbAttachment {
  id: string;
  fileName?: string;
  mimeType?: string;
}

export type MaterialKind = 'folder' | 'file' | 'document' | 'link' | 'other';

export interface MaterialItem {
  id: string;
  title: string;
  /** Titles of the folders above it, outermost first */
  path: string[];
  kind: MaterialKind;
  modified: string | null;
  /** Web link of an external-link item */
  url: string | null;
}

export interface MaterialFile {
  contentId: string;
  attachmentId: string;
  fileName: string;
  mimeType: string;
  /** Title of the content item that holds it */
  title: string;
  path: string[];
  modified: string | null;
}

export interface StoredMaterialFile extends MaterialFile {
  /** Path under data/materials/<CODE>/, with forward slashes */
  file: string;
  bytes: number;
  sha256: string;
}

export interface MaterialsIndex {
  version: 1;
  course: string;
  courseId: string;
  /** The subject's page on the campus (for "open it on the campus" links) */
  courseUrl: string;
  updatedAt: string;
  items: MaterialItem[];
  files: StoredMaterialFile[];
}

/** "_250115_1" from ".../ultra/courses/_250115_1/outline". */
export function courseIdFromUrl(url: string | null | undefined): string | null {
  return /\/courses\/(_\d+_\d+)(?:\/|$|\?)/.exec(url ?? '')?.[1] ?? null;
}

export function contentKind(c: BbContent): MaterialKind {
  const h = c.contentHandler?.id ?? '';
  if (/folder|lesson/i.test(h)) return 'folder';
  if (/x-bb-file/i.test(h)) return 'file';
  if (/document|item/i.test(h)) return 'document';
  if (/externallink|x-bb-link/i.test(h)) return 'link';
  return 'other';
}

/** Hidden from students (or not yet released): not the student's material. */
export function isVisible(c: BbContent): boolean {
  const a = c.availability?.available;
  return !a || !/^no$/i.test(a);
}

const KEEP_EXT = /\.(pdf|pptx?|docx?|xlsx?|odt|odp|zip|m|py|txt|csv)$/i;
const KEEP_MIME = /pdf|presentation|powerpoint|wordprocessing|msword|spreadsheet|excel|zip|text\/plain|csv/i;

/** Study material (slides, notes, exercises, code), not videos or images. */
export function wantedFile(fileName: string, mimeType = ''): boolean {
  return KEEP_EXT.test(fileName) || KEEP_MIME.test(mimeType);
}

/** One folder or file name a disk accepts; never "..", never a separator (a name cannot climb out of its folder). */
function safePart(part: string): string {
  const clean = part
    .normalize('NFC')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..')
    .join(' ')
    .replace(/[:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim();
  return (clean || 'sin-nombre').slice(0, 80);
}

/** Where a file goes: its folders, then its own name ("Tema 1. Amplificadores/Diapositivas tema 1.pdf"). */
export function storagePath(f: Pick<MaterialFile, 'path' | 'fileName' | 'attachmentId'>): string {
  // Only the last part of what the campus calls the file: "../../x.pdf" is "x.pdf"
  const name = safePart(f.fileName.split(/[\\/]+/).filter(Boolean).pop() ?? '');
  return [...f.path.map(safePart), name].join('/');
}

/** Files that are new, or changed on the campus since they were stored. */
export function planDownloads(files: MaterialFile[], stored: StoredMaterialFile[]): MaterialFile[] {
  const known = new Map(stored.map((s) => [`${s.contentId}/${s.attachmentId}`, s]));
  return files.filter((f) => {
    const s = known.get(`${f.contentId}/${f.attachmentId}`);
    return !s || (f.modified ?? '') !== (s.modified ?? '') || s.fileName !== f.fileName;
  });
}

const TOPIC = /^\s*(?:tema|unidad|bloque|m[oó]dulo|cap[ií]tulo)\s*(\d{1,2})\s*(?:[.:\-–)]\s*)?(.*)$/i;

/**
 * The syllabus the campus folders spell out ("Tema 1. Amplificadores y filtros", "TEMA 2 - Instrumentación"),
 * in order, one entry per number. Nothing when fewer than two topics are found: a single folder is no syllabus.
 */
export function syllabusFromMaterials(items: MaterialItem[]): { n: number; title: string }[] {
  const byNumber = new Map<number, string>();
  // Folders first: they name the topic; a file called "Tema 1" is usually its slides
  const ordered = [...items].sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder'));
  for (const item of ordered) {
    const m = TOPIC.exec(item.title);
    if (!m) continue;
    const n = Number(m[1]);
    const title = m[2]!.replace(/\.(pdf|pptx?|docx?)$/i, '').replace(/\s+/g, ' ').trim();
    if (n < 1 || n > 30 || byNumber.has(n) || title.length < 3) continue;
    byNumber.set(n, title);
  }
  const list = [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([n, title]) => ({ n, title }));
  return list.length >= 2 ? list : [];
}

/** Items of a folder level, in the order of the campus, with the folder path they sit in. */
export function toItems(contents: BbContent[], path: string[]): MaterialItem[] {
  return contents.filter(isVisible).map((c) => ({
    id: c.id,
    title: (c.title ?? '').replace(/\s+/g, ' ').trim() || 'Sin título',
    path,
    kind: contentKind(c),
    modified: c.modified ?? c.created ?? null,
    url: contentKind(c) === 'link' ? c.contentHandler?.url ?? null : null,
  }));
}

/** Folders whose names say they are not course content (announcements, grades, the virtual classroom). */
export function skipFolder(title: string): boolean {
  return /^(anuncios|calificaciones|mis calificaciones|class collaborate|foro|foros|debates|mensajes)$/i.test(fold(title).trim());
}
