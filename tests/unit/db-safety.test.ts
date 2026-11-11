import { describe, expect, it } from 'vitest';
import { syncedFolderName, untitledClasses, webShrinks } from '../../src/database/safety.js';

describe('syncedFolderName', () => {
  it('spots the folders that sync tools rewrite behind SQLite', () => {
    expect(syncedFolderName('C:\\Users\\ana\\OneDrive\\Escritorio\\lecture-vault\\data\\lecturevault.db')).toBe('OneDrive');
    expect(syncedFolderName('C:/Users/ana/OneDrive - Universidad/app/data/lv.db')).toBe('OneDrive');
    expect(syncedFolderName('/Users/ana/Dropbox/lv/data/lv.db')).toBe('Dropbox');
    expect(syncedFolderName('G:\\Mi unidad\\lv\\lv.db')).toBe('Google Drive');
    expect(syncedFolderName('/Users/ana/Google Drive/lv.db')).toBe('Google Drive');
    expect(syncedFolderName('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/lv.db')).toBe('iCloud Drive');
  });

  it('leaves ordinary local folders alone', () => {
    expect(syncedFolderName('C:\\Users\\ana\\AppData\\Local\\LectureVault\\lecturevault.db')).toBeNull();
    expect(syncedFolderName('/home/runner/work/lecturevault/data/lecturevault.db')).toBeNull();
    // A word that merely contains the name is not the synced folder
    expect(syncedFolderName('C:/proyectos/onedrive-notes/lv.db')).toBeNull();
  });
});

describe('webShrinks', () => {
  it('stops a database that suddenly lost most of its classes from overwriting the published web', () => {
    // What happened on 2026-11-07: a 15-class web against a database rolled back to 1 class
    expect(webShrinks(15, 1)).toBe(true);
    expect(webShrinks(15, 0)).toBe(true);
    expect(webShrinks(15, 12)).toBe(true);
  });

  it('lets ordinary changes through', () => {
    expect(webShrinks(15, 15)).toBe(false);
    expect(webShrinks(15, 16)).toBe(false);
    expect(webShrinks(15, 14)).toBe(false); // one class deleted on purpose
    expect(webShrinks(0, 0)).toBe(false); // nothing published yet
    expect(webShrinks(0, 3)).toBe(false);
  });
});

describe('untitledClasses', () => {
  it('lists transcribed classes of a course that have no campus title', () => {
    const rows = [
      { id: 1, course: '01MUIN', display_title: 'Clase 1. Algo', segment_count: 10 },
      { id: 2, course: '01MUIN', display_title: null, segment_count: 10 },
      { id: 3, course: '01MUIN', display_title: '  ', segment_count: 4 },
      { id: 4, course: '', display_title: null, segment_count: 4 },
      { id: 5, course: '01MUIN', display_title: null, segment_count: 0 },
    ];
    expect(untitledClasses(rows)).toEqual([2, 3]);
  });
});
