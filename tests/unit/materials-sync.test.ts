import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { APIRequestContext } from 'playwright';
import { loadMaterialsIndex, materialsDir, syncCourseMaterials } from '../../src/campus/materials-sync.js';

const ORIGIN = 'https://learn.example.edu';
const COURSE_URL = `${ORIGIN}/ultra/courses/_250115_1/outline`;

/** A campus that answers like Blackboard Learn: a content tree, attachments and their bytes. */
function fakeCampus(routes: Record<string, unknown>, opts: { publicApi?: boolean } = {}) {
  const calls: string[] = [];
  const request = {
    async get(url: string) {
      calls.push(url);
      const key = url.replace(ORIGIN, '');
      const usable = opts.publicApi === false ? !key.includes('/api/public/') : true;
      const body = usable ? routes[key] : undefined;
      return {
        ok: () => body !== undefined,
        status: () => (body === undefined ? 404 : 200),
        json: async () => body,
        body: async () => (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))),
      };
    },
  } as unknown as APIRequestContext;
  return { request, calls };
}

const tree = (prefix: string) => ({
  [`${prefix}`]: { results: [
    { id: '_1_1', title: 'Tema 1. Amplificadores y filtros', contentHandler: { id: 'resource/x-bb-folder' }, hasChildren: true },
    { id: '_2_1', title: 'Tema 2. Aplicaciones de la instrumentación', contentHandler: { id: 'resource/x-bb-folder' }, hasChildren: true },
    { id: '_9_1', title: 'Anuncios', contentHandler: { id: 'resource/x-bb-folder' }, hasChildren: true },
    { id: '_8_1', title: 'Borrador del profesor', contentHandler: { id: 'resource/x-bb-file' }, availability: { available: 'No' } },
  ] },
});
const children = (base: string) => ({
  [`${base}/_1_1/children`]: { results: [
    { id: '_11_1', title: 'Diapositivas', contentHandler: { id: 'resource/x-bb-file' }, modified: '2026-10-20T10:00:00Z' },
    { id: '_12_1', title: 'Vídeo de la clase', contentHandler: { id: 'resource/x-bb-file' }, modified: '2026-10-20T10:00:00Z' },
  ] },
  [`${base}/_2_1/children`]: { results: [], paging: {} },
  [`${base}/_11_1/attachments`]: { results: [{ id: '_a_1', fileName: 'tema1.pdf', mimeType: 'application/pdf' }] },
  [`${base}/_12_1/attachments`]: { results: [{ id: '_v_1', fileName: 'clase.mp4', mimeType: 'video/mp4' }] },
  [`${base}/_11_1/attachments/_a_1/download`]: Buffer.from('%PDF-1.4 tema 1'),
});

describe('syncCourseMaterials', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-mat-')); });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const base = '/learn/api/public/v1/courses/_250115_1/contents';
  const run = (request: APIRequestContext, mode: 'list' | 'download' = 'download') =>
    syncCourseMaterials(request, { dataDir, code: '04MUIN', course: '04MUIN Tecnología', courseUrl: COURSE_URL, mode });

  it('walks the visible folders, keeps the study files and reads the syllabus', async () => {
    const { request, calls } = fakeCampus({ ...tree(base), ...children(base) });
    const out = await run(request);
    expect(out).toMatchObject({ files: 1, downloaded: 1, changed: true, skipped: [] });
    expect(out.syllabus).toEqual([{ n: 1, title: 'Amplificadores y filtros' }, { n: 2, title: 'Aplicaciones de la instrumentación' }]);
    // Announcements and hidden items are not walked
    expect(calls.some((c) => c.includes('_9_1'))).toBe(false);
    expect(calls.some((c) => c.includes('_8_1'))).toBe(false);
    const file = path.join(materialsDir(dataDir, '04MUIN'), 'Tema 1. Amplificadores y filtros', 'tema1.pdf');
    expect(fs.readFileSync(file, 'utf8')).toBe('%PDF-1.4 tema 1');
    const index = loadMaterialsIndex(dataDir, '04MUIN')!;
    expect(index.courseId).toBe('_250115_1');
    expect(index.files).toHaveLength(1);
    expect(index.files[0]).toMatchObject({ fileName: 'tema1.pdf', file: 'Tema 1. Amplificadores y filtros/tema1.pdf', bytes: 15 });
  });

  it('does not download again what has not changed, and reports no change', async () => {
    const { request } = fakeCampus({ ...tree(base), ...children(base) });
    await run(request);
    const again = fakeCampus({ ...tree(base), ...children(base) });
    const out = await run(again.request);
    expect(out).toMatchObject({ downloaded: 0, changed: false });
    expect(again.calls.some((c) => c.endsWith('/download'))).toBe(false);
  });

  it('only lists in list mode', async () => {
    const { request, calls } = fakeCampus({ ...tree(base), ...children(base) });
    const out = await run(request, 'list');
    expect(out).toMatchObject({ files: 1, downloaded: 0 });
    expect(calls.some((c) => c.endsWith('/download'))).toBe(false);
    expect(loadMaterialsIndex(dataDir, '04MUIN')!.items.length).toBeGreaterThan(0);
  });

  it('uses the API Ultra itself calls when the public one does not answer', async () => {
    const priv = '/learn/api/v1/courses/_250115_1/contents';
    const routes = { ...children(priv), [`${priv}/ROOT/children`]: tree('x')['x'] };
    const { request } = fakeCampus(routes, { publicApi: false });
    const out = await run(request);
    expect(out.api).toContain('/learn/api/v1/');
    expect(out.downloaded).toBe(1);
  });

  it('says plainly when the campus does not answer at all', async () => {
    const { request } = fakeCampus({});
    await expect(run(request)).rejects.toThrow(/no respondió/);
  });
});
