/**
 * Fetches a subject's materials from the campus with the browser session the daily agent already has
 * (Playwright's `page.request` shares its cookies): the content tree, and the files worth keeping.
 *
 * Blackboard Learn answers its public REST API (/learn/api/public/v1) and the one Ultra itself uses
 * (/learn/api/v1) to a logged-in browser; the first that answers is used. Nothing here can fail the night:
 * the agent catches and logs. Bounded on purpose: folder depth, number of files, size of each file and of
 * the whole night, and every file stays inside data/materials/<CODE>/.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from 'playwright';
import type { Logger } from 'pino';
import {
  courseIdFromUrl, planDownloads, skipFolder, storagePath, syllabusFromMaterials, toItems, wantedFile,
  type BbAttachment, type BbContent, type MaterialFile, type MaterialItem, type MaterialsIndex, type StoredMaterialFile,
} from './materials.js';

export type MaterialsMode = 'off' | 'list' | 'download';

export interface SyncMaterialsOptions {
  dataDir: string;
  /** Catalog code, e.g. 04MUIN (folder name) */
  code: string;
  /** Catalog label, e.g. "04MUIN Tecnología electrónica e instrumentación" */
  course: string;
  /** The subject's Ultra page (…/ultra/courses/_123_1/outline) */
  courseUrl: string;
  mode: Exclude<MaterialsMode, 'off'>;
  logger?: Logger;
  maxDepth?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  /** Shared across the subjects of one night */
  budget?: { bytes: number };
}

export interface SyncMaterialsResult {
  items: number;
  files: number;
  downloaded: number;
  skipped: string[];
  syllabus: { n: number; title: string }[];
  /** True when index.json or a file changed (worth committing) */
  changed: boolean;
  api: string;
}

export function materialsDir(dataDir: string, code: string): string {
  return path.join(dataDir, 'materials', code.replace(/[^\w-]+/g, '_'));
}

export function loadMaterialsIndex(dataDir: string, code: string): MaterialsIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(materialsDir(dataDir, code), 'index.json'), 'utf8')) as MaterialsIndex;
    return parsed?.version === 1 && Array.isArray(parsed.items) && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

interface Page<T> {
  results?: T[];
  paging?: { nextPage?: string };
}

export async function syncCourseMaterials(request: APIRequestContext, opts: SyncMaterialsOptions): Promise<SyncMaterialsResult> {
  const courseId = courseIdFromUrl(opts.courseUrl);
  if (!courseId) throw new Error(`No se conoce el identificador de ${opts.code} en el campus`);
  const origin = new URL(opts.courseUrl).origin;
  const maxDepth = opts.maxDepth ?? 6;
  const maxFiles = opts.maxFiles ?? 200;
  const maxFileBytes = opts.maxFileBytes ?? 25 * 1024 * 1024;
  const budget = opts.budget ?? { bytes: 150 * 1024 * 1024 };
  const skipped: string[] = [];

  const getJson = async <T>(url: string): Promise<T | null> => {
    const res = await request.get(url, { headers: { Accept: 'application/json' }, timeout: 30_000 });
    if (!res.ok()) return null;
    try {
      return (await res.json()) as T;
    } catch {
      return null;
    }
  };

  // Which API this campus answers: the public one, or Ultra's own
  const apis = [
    { base: `${origin}/learn/api/public/v1/courses/${courseId}/contents`, root: '' },
    { base: `${origin}/learn/api/v1/courses/${courseId}/contents`, root: '/ROOT/children' },
  ];
  let api = '';
  let root: Page<BbContent> | null = null;
  for (const candidate of apis) {
    root = await getJson<Page<BbContent>>(candidate.base + candidate.root);
    if (root?.results) {
      api = candidate.base;
      break;
    }
  }
  if (!api || !root?.results) throw new Error('El campus no respondió a la API de contenidos (¿sesión caducada?)');

  const pageAll = async (first: Page<BbContent> | null): Promise<BbContent[]> => {
    const out = [...(first?.results ?? [])];
    let next = first?.paging?.nextPage;
    for (let n = 0; next && n < 20; n++) {
      const more = await getJson<Page<BbContent>>(new URL(next, origin).toString());
      out.push(...(more?.results ?? []));
      next = more?.paging?.nextPage;
    }
    return out;
  };

  const items: MaterialItem[] = [];
  const files: MaterialFile[] = [];
  const walk = async (contents: BbContent[], trail: string[], depth: number): Promise<void> => {
    const level = toItems(contents, trail);
    items.push(...level);
    for (const item of level) {
      if (files.length >= maxFiles) return;
      if (item.kind === 'folder') {
        if (depth >= maxDepth || skipFolder(item.title)) continue;
        const children = await pageAll(await getJson<Page<BbContent>>(`${api}/${item.id}/children`));
        await walk(children, [...trail, item.title], depth + 1);
      } else if (item.kind === 'file' || item.kind === 'document') {
        const atts = await getJson<Page<BbAttachment>>(`${api}/${item.id}/attachments`);
        for (const a of atts?.results ?? []) {
          const fileName = a.fileName ?? '';
          if (!fileName || !wantedFile(fileName, a.mimeType)) continue;
          files.push({ contentId: item.id, attachmentId: a.id, fileName, mimeType: a.mimeType ?? '', title: item.title, path: trail, modified: item.modified });
        }
      }
    }
  };
  await walk(await pageAll(root), [], 0);

  const dir = materialsDir(opts.dataDir, opts.code);
  const previous = loadMaterialsIndex(opts.dataDir, opts.code);
  const stored = new Map((previous?.files ?? []).map((f) => [`${f.contentId}/${f.attachmentId}`, f]));
  let downloaded = 0;

  if (opts.mode === 'download') {
    for (const f of planDownloads(files, previous?.files ?? [])) {
      const rel = storagePath(f);
      const target = path.resolve(dir, rel);
      if (!target.startsWith(path.resolve(dir) + path.sep)) {
        skipped.push(`${f.fileName}: ruta no válida`);
        continue;
      }
      const res = await request.get(`${api}/${f.contentId}/attachments/${f.attachmentId}/download`, { timeout: 120_000 });
      if (!res.ok()) {
        skipped.push(`${f.fileName}: el campus respondió ${res.status()}`);
        continue;
      }
      const body = await res.body();
      if (body.length > maxFileBytes) {
        skipped.push(`${f.fileName}: ${Math.round(body.length / 1048576)} MB, demasiado grande`);
        continue;
      }
      if (body.length > budget.bytes) {
        skipped.push(`${f.fileName}: se deja para otra noche (límite de descarga)`);
        continue;
      }
      budget.bytes -= body.length;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      stored.set(`${f.contentId}/${f.attachmentId}`, {
        ...f,
        file: rel,
        bytes: body.length,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
      });
      downloaded++;
    }
  }

  // The index lists what the campus has now; a file that left the campus stays on disk (nothing is deleted)
  const current = new Set(files.map((f) => `${f.contentId}/${f.attachmentId}`));
  const index: MaterialsIndex = {
    version: 1,
    course: opts.course,
    courseId,
    courseUrl: opts.courseUrl,
    updatedAt: new Date().toISOString(),
    items,
    files: [...stored.entries()].filter(([key]) => current.has(key)).map(([, f]) => f as StoredMaterialFile),
  };
  const before = previous ? JSON.stringify({ ...previous, updatedAt: '' }) : '';
  const after = JSON.stringify({ ...index, updatedAt: '' });
  const changed = before !== after;
  if (changed) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }
  opts.logger?.info({ code: opts.code, api, items: items.length, files: files.length, downloaded, skipped: skipped.length }, 'campus materials synced');
  return { items: items.length, files: files.length, downloaded, skipped, syllabus: syllabusFromMaterials(items), changed, api };
}
