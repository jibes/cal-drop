import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 5;
/** Below this much extracted text a PDF is almost certainly a scan or a
 *  vector poster with outlined type — render it and let the vision model read it. */
const TEXT_THRESHOLD = 200;

export interface PdfContent {
  text: string;
  images: string[];
  pages: number;
}

export async function readPdf(file: File): Promise<PdfContent> {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pageCount = Math.min(doc.numPages, MAX_PAGES);

  let text = '';
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items
      .map((item) => ('str' in item ? (item as TextItem).str : ''))
      .join(' ');
    text += '\n\n';
  }

  const images: string[] = [];
  if (text.trim().length < TEXT_THRESHOLD) {
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(viewport.width, viewport.height));
      const scaled = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(scaled.width);
      canvas.height = Math.round(scaled.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) break;
      await page.render({ canvasContext: ctx, viewport: scaled }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.85));
    }
  }

  await doc.destroy();
  return { text: text.trim(), images, pages: doc.numPages };
}
