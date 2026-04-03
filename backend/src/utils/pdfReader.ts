import * as fs from 'fs';
import * as path from 'path';

export async function readPdfAsText(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  if (path.extname(absolutePath).toLowerCase() !== '.pdf') {
    throw new Error(`Not a PDF file: ${absolutePath}`);
  }

  // pdfjs-dist requires a legacy build for Node
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const data = new Uint8Array(fs.readFileSync(absolutePath));
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdfDocument = await loadingTask.promise;

  const numPages = pdfDocument.numPages;
  const textParts: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .join(' ');
    textParts.push(`--- Page ${i} ---\n${pageText}`);
  }

  return textParts.join('\n\n');
}