import { describe, expect, it } from 'vitest';
import {
  contentKind, courseIdFromUrl, isVisible, planDownloads, skipFolder, storagePath, syllabusFromMaterials, toItems, wantedFile,
  type MaterialFile, type MaterialItem, type StoredMaterialFile,
} from '../../src/campus/materials.js';

describe('materials from the campus', () => {
  it('reads the course id of an Ultra address', () => {
    expect(courseIdFromUrl('https://learn.universidadviu.com/ultra/courses/_250115_1/outline')).toBe('_250115_1');
    expect(courseIdFromUrl('https://learn.universidadviu.com/ultra/courses/_250115_1')).toBe('_250115_1');
    expect(courseIdFromUrl('https://learn.universidadviu.com/ultra/stream')).toBeNull();
    expect(courseIdFromUrl(undefined)).toBeNull();
  });

  it('tells folders, files, documents and links apart, and keeps only what students see', () => {
    expect(contentKind({ id: '1', contentHandler: { id: 'resource/x-bb-folder' } })).toBe('folder');
    expect(contentKind({ id: '1', contentHandler: { id: 'resource/x-bb-lesson' } })).toBe('folder');
    expect(contentKind({ id: '1', contentHandler: { id: 'resource/x-bb-file' } })).toBe('file');
    expect(contentKind({ id: '1', contentHandler: { id: 'resource/x-bb-document' } })).toBe('document');
    expect(contentKind({ id: '1', contentHandler: { id: 'resource/x-bb-externallink', url: 'https://x' } })).toBe('link');
    expect(isVisible({ id: '1', availability: { available: 'No' } })).toBe(false);
    expect(isVisible({ id: '1', availability: { available: 'Yes' } })).toBe(true);
    const items = toItems([
      { id: 'a', title: ' Tema 1.  Amplificadores ', contentHandler: { id: 'resource/x-bb-folder' }, modified: '2026-10-20T10:00:00Z' },
      { id: 'b', title: 'Oculto', availability: { available: 'No' } },
      { id: 'c', title: 'Simulador', contentHandler: { id: 'resource/x-bb-externallink', url: 'https://sim.example' } },
    ], ['Contenido']);
    expect(items).toEqual([
      { id: 'a', title: 'Tema 1. Amplificadores', path: ['Contenido'], kind: 'folder', modified: '2026-10-20T10:00:00Z', url: null },
      { id: 'c', title: 'Simulador', path: ['Contenido'], kind: 'link', modified: null, url: 'https://sim.example' },
    ]);
  });

  it('keeps study material and leaves videos and images', () => {
    expect(wantedFile('Tema 1 - Diapositivas.pdf')).toBe(true);
    expect(wantedFile('practica.PPTX')).toBe(true);
    expect(wantedFile('newton_raphson.m')).toBe(true);
    expect(wantedFile('archivo', 'application/pdf')).toBe(true);
    expect(wantedFile('clase.mp4', 'video/mp4')).toBe(false);
    expect(wantedFile('logo.png', 'image/png')).toBe(false);
  });

  it('stores each file under its folders with a name any disk accepts', () => {
    expect(storagePath({ path: ['Tema 2: Instrumentación', 'Práctica?'], fileName: 'Guía <v2>.pdf', attachmentId: 'x' }))
      .toBe('Tema 2 Instrumentación/Práctica/Guía v2 .pdf');
    expect(storagePath({ path: [], fileName: '../../secreto.pdf', attachmentId: 'x' })).toBe('secreto.pdf');
  });

  it('downloads only what is new or changed on the campus', () => {
    const f = (id: string, modified: string): MaterialFile => ({ contentId: id, attachmentId: 'a', fileName: `${id}.pdf`, mimeType: 'application/pdf', title: id, path: [], modified });
    const stored: StoredMaterialFile[] = [
      { ...f('same', '2026-10-01'), file: 'same.pdf', bytes: 1, sha256: 'x' },
      { ...f('changed', '2026-10-01'), file: 'changed.pdf', bytes: 1, sha256: 'x' },
    ];
    expect(planDownloads([f('same', '2026-10-01'), f('changed', '2026-11-02'), f('new', '2026-11-03')], stored).map((x) => x.contentId))
      .toEqual(['changed', 'new']);
  });

  it('reads the syllabus from the folder names, folders before files', () => {
    const item = (title: string, kind: MaterialItem['kind'] = 'folder'): MaterialItem => ({ id: title, title, path: [], kind, modified: null, url: null });
    expect(syllabusFromMaterials([
      item('Guía docente', 'file'),
      item('TEMA 2 - Aplicaciones de la instrumentación'),
      item('Tema 1. Amplificadores y filtros'),
      item('Tema 1 diapositivas.pdf', 'file'),
      item('Unidad 3: Sistemas de adquisición'),
    ])).toEqual([
      { n: 1, title: 'Amplificadores y filtros' },
      { n: 2, title: 'Aplicaciones de la instrumentación' },
      { n: 3, title: 'Sistemas de adquisición' },
    ]);
    // One topic is not a syllabus
    expect(syllabusFromMaterials([item('Tema 1. Introducción')])).toEqual([]);
  });

  it('skips the folders that are not course content', () => {
    expect(skipFolder('Anuncios')).toBe(true);
    expect(skipFolder('Class Collaborate')).toBe(true);
    expect(skipFolder('Tema 1')).toBe(false);
  });
});
