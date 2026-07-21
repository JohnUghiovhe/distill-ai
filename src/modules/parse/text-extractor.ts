import { extname } from 'node:path';
import * as SYS_MSG from '@constants/system-messages';

/**
 * Hard cap on extracted text per attachment, in characters. A pathological PDF can hold far more
 * text than the downstream extract step needs; capping keeps a single attachment from bloating the
 * `attachments.parsed_text` row (and later token budgets).
 */
export const MAX_PARSED_TEXT_CHARS = 1_000_000;

export class UnsupportedFileTypeError extends Error {}

/**
 * Extract plain text from an attachment's bytes, dispatched by file extension (the canonical signal
 * the ingestion endpoint already validated against its pdf/csv/txt allowlist):
 * - `.txt` / `.csv`: the bytes are already text; returned as UTF-8 as-is.
 * - `.pdf`: run through pdf-parse.
 * Throws {@link UnsupportedFileTypeError} for any other extension. Output is truncated to {@link MAX_PARSED_TEXT_CHARS}.
 */
export async function extractText(bytes: Buffer, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase();
  let text: string;
  switch (ext) {
    case '.txt':
    case '.csv':
      text = bytes.toString('utf8');
      break;
    case '.pdf':
      text = await extractPdfText(bytes);
      break;
    default:
      throw new UnsupportedFileTypeError(SYS_MSG.PARSE_UNSUPPORTED_TYPE(ext));
  }
  return text.length > MAX_PARSED_TEXT_CHARS ? text.slice(0, MAX_PARSED_TEXT_CHARS) : text;
}

/** Run pdf-parse over the buffer and return the concatenated document text, always releasing the
 * parser's resources afterwards. Imported lazily: `pdf-parse` loads a native canvas binding at
 * require time, so a top-level import lets a PDF-only dependency failure crash the whole worker and
 * take `.txt`/`.csv` parsing down with it. */
async function extractPdfText(bytes: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}
