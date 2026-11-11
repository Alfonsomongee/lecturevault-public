/**
 * PDF of the notes, printed by headless Chromium from the dashboard's own print page (/print.html), so
 * the PDF shows exactly what the app shows: the same Markdown renderer, KaTeX and callouts. One browser
 * at a time: a PDF of a whole course is heavy and nobody waits on two of them.
 */

import { chromium } from 'playwright';
import type { Logger } from 'pino';

const PAGE_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 90_000;

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Footer: the document title on the left, "page / total" on the right, over a hairline (aligned with the page margins). */
export function footerTemplate(label: string): string {
  const text = escapeHtml(label.length > 90 ? `${label.slice(0, 89)}…` : label);
  return (
    '<div style="width:100%;box-sizing:border-box;padding:0 17mm;font-family:Segoe UI,Arial,sans-serif;font-size:7.5px;color:#7b818a">' +
    '<div style="display:flex;justify-content:space-between;border-top:0.5px solid #cfd2d6;padding-top:5px">' +
    `<span>${text}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span>` +
    '</div></div>'
  );
}

export class PdfExporter {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly logger?: Logger;

  /** `baseUrl` is read per call: the server may not be listening yet when this is created. */
  constructor(private readonly baseUrl: () => string, logger?: Logger) {
    this.logger = logger?.child({ component: 'pdf-exporter' });
  }

  /** Print `/print.html?…` (a path with its query) and return the PDF. */
  render(pathAndQuery: string, label = ''): Promise<Buffer> {
    const run = this.queue.then(() => this.print(pathAndQuery, label));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async print(pathAndQuery: string, label: string): Promise<Buffer> {
    const started = Date.now();
    let browser;
    try {
      browser = await chromium.launch({ headless: true, channel: process.env['BROWSER_CHANNEL'] || undefined });
    } catch (err) {
      const message = (err as Error).message;
      throw new Error(
        /Executable doesn't exist|browserType\.launch/i.test(message)
          ? 'No se pudo abrir el navegador para generar el PDF. Instálalo con: npx playwright install chromium'
          : `No se pudo abrir el navegador para generar el PDF: ${message.split('\n')[0]}`
      );
    }
    try {
      const page = await browser.newPage();
      await page.goto(`${this.baseUrl()}${pathAndQuery}`, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
      await page.waitForSelector('body[data-ready="1"]', { state: 'attached', timeout: READY_TIMEOUT_MS });
      const error = await page.getAttribute('body', 'data-error');
      if (error) throw new Error(error);
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: false,
        // Bookmarks (the PDF's own index). Chromium builds them from the document structure, so without `tagged`
        // `outline` is silently ignored: the PDF has no index at all (checked in the e2e test)
        tagged: true,
        outline: true,
        margin: { top: '18mm', bottom: '20mm', left: '17mm', right: '17mm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: footerTemplate(label),
      });
      this.logger?.info({ path: pathAndQuery.split('?')[0], bytes: pdf.length, ms: Date.now() - started }, 'PDF generado');
      return pdf;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}
