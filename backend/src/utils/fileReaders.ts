import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import * as mammoth from 'mammoth';
import { getCredentialForProvider } from '../vault/credentialVault';

const MAX_ROWS_PER_SHEET = 100;
const MAX_OUTPUT_CHARS = 20_000;

function resolveContainedPath(filePath: string): string {
  const allowedRoot = getCredentialForProvider('filesystem');
  if (!allowedRoot) {
    throw new Error('No filesystem folder has been authorized. Configure the Local Filesystem integration before reading files.');
  }

  const resolvedRoot = path.resolve(allowedRoot);
  const absolutePath = path.resolve(resolvedRoot, filePath);

  const isContained = absolutePath === resolvedRoot || absolutePath.startsWith(resolvedRoot + path.sep);
  if (!isContained) {
    throw new Error('Access denied: path is outside the authorized folder.');
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  return absolutePath;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map(t => t.text).join('');
    }
    if ('result' in value) {
      return cellToString((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    }
    if ('text' in value) {
      return String((value as ExcelJS.CellHyperlinkValue).text);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function worksheetToCsv(worksheet: ExcelJS.Worksheet): string {
  const totalRows = worksheet.rowCount;
  const columnCount = worksheet.columnCount;
  const shown = Math.min(totalRows, MAX_ROWS_PER_SHEET);

  const lines: string[] = [];
  for (let r = 1; r <= shown; r++) {
    const row = worksheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= columnCount; c++) {
      cells.push(csvEscape(cellToString(row.getCell(c).value)));
    }
    lines.push(cells.join(','));
  }

  if (totalRows > shown) {
    lines.push(`[showing first ${shown} of ${totalRows} rows]`);
  }

  return lines.join('\n');
}

export async function readSpreadsheetAsText(filePath: string): Promise<string> {
  const absolutePath = resolveContainedPath(filePath);
  const ext = path.extname(absolutePath).toLowerCase();

  if (ext === '.xls') {
    throw new Error('Legacy .xls files are not supported — convert the file to .xlsx or .csv.');
  }
  if (ext !== '.xlsx' && ext !== '.csv') {
    throw new Error(`Not a supported spreadsheet file: ${absolutePath}`);
  }

  const workbook = new ExcelJS.Workbook();

  let sections: string[];
  if (ext === '.csv') {
    const worksheet = await workbook.csv.readFile(absolutePath);
    sections = [worksheetToCsv(worksheet)];
  } else {
    await workbook.xlsx.readFile(absolutePath);
    sections = workbook.worksheets.map(worksheet =>
      `=== Sheet: ${worksheet.name} ===\n${worksheetToCsv(worksheet)}`
    );
  }

  let output = sections.join('\n\n');
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + `\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`;
  }

  return output;
}

export async function readDocumentAsText(filePath: string): Promise<string> {
  const absolutePath = resolveContainedPath(filePath);

  if (path.extname(absolutePath).toLowerCase() !== '.docx') {
    throw new Error(`Not a supported document file: ${absolutePath}`);
  }

  const result = await mammoth.extractRawText({ path: absolutePath });
  let output = result.value.trim();

  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS) + `\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`;
  }

  return output;
}
