/**
 * Guards for the database file itself (pure, testable).
 *
 * On 2026-11-07 the live database inside OneDrive came back as an old copy from 26 October (1 class instead
 * of 17). Sync tools rewrite files behind SQLite's back, and a later export would have published that
 * shrunken database to the friends' web. These two checks make that loud instead of silent.
 */

/** Name of the sync tool whose folder holds this path, or null for an ordinary local folder. */
export function syncedFolderName(file: string): string | null {
  const parts = file.split(/[\\/]+/).map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === 'onedrive' || part.startsWith('onedrive - ')) return 'OneDrive';
    if (part === 'dropbox' || part.startsWith('dropbox (')) return 'Dropbox';
    if (part === 'google drive' || part === 'googledrive' || part === 'my drive' || part === 'mi unidad') return 'Google Drive';
    if (part === 'icloud drive' || part === 'iclouddrive' || part === 'com~apple~clouddocs') return 'iCloud Drive';
  }
  return null;
}

/**
 * True when a database with `current` classes should not replace a published web that shows `published`:
 * more than two classes, or more than a quarter of them, gone at once is a rolled-back or wrong database,
 * not an edit. `export:web --force` overrides it.
 */
export function webShrinks(published: number, current: number): boolean {
  const lost = published - current;
  if (lost <= 0) return false;
  return lost > 2 || lost * 4 > published;
}

/**
 * Ids of the classes the web would show without a campus title: they have a course and a transcript but the
 * AI analysis never reached this database (the cloud analysed them in its own copy, or the queue was cut).
 * Publishing them replaces a titled class on the friends' web with a bare one, so the export refuses.
 */
export function untitledClasses(rows: Array<{ id: number; course: string | null; display_title: string | null; segment_count: number }>): number[] {
  return rows.filter((r) => r.segment_count > 0 && !!r.course && !(r.display_title ?? '').trim()).map((r) => r.id);
}
