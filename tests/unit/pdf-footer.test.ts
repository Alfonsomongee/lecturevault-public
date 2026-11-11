import { describe, expect, it } from 'vitest';
import { footerTemplate } from '../../src/export/PdfExporter.js';

describe('footerTemplate', () => {
  it('shows the title and the page counters', () => {
    const html = footerTemplate('Clase 3. Sistemas de control');
    expect(html).toContain('Clase 3. Sistemas de control');
    expect(html).toContain('class="pageNumber"');
    expect(html).toContain('class="totalPages"');
  });

  it('escapes markup in the title', () => {
    const html = footerTemplate('<img src=x onerror=alert(1)> & "co"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;img');
  });

  it('shortens a very long title', () => {
    const html = footerTemplate('x'.repeat(300));
    expect(html).toContain('…');
    expect(html.length).toBeLessThan(900);
  });
});
