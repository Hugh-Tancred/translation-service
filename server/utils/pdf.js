'use strict';

/**
 * pdf.js  —  PDF extraction and reconstruction utility
 *
 * Exports:
 *   extractText(pdfBuffer)             → { text, pageCount }
 *   createPdfFromText(text, filename, footnotes)  → Buffer
 *
 * Footnote contract (footnotes array):
 *   [{ number: 1, text: "Footnote body..." }, ...]
 *
 * Body text convention:
 *   Inline markers look like [FN1], [FN2] etc.
 *   createPdfFromText renders these as superscript-style numbers.
 *
 * Font requirement:
 *   A TTF file must exist at the path in FONT_PATH below.
 *   LiberationSans-Regular.ttf ships with most Linux distros:
 *     apt install fonts-liberation   (if missing)
 *   Or drop any Unicode-capable TTF at the path and update FONT_PATH.
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

// ─── Font path ────────────────────────────────────────────────────────────────
// Adjust if your font lives elsewhere.  The file must support the full
// Latin Extended-A block to handle Polish, Danish, Slovenian etc.
const FONT_PATH = path.join(__dirname, '../../fonts/LiberationSans-Regular.ttf');

// ─── Page geometry (A4 in points, 72pt = 1 inch) ─────────────────────────────
const PAGE_WIDTH   = 595.28;
const PAGE_HEIGHT  = 841.89;
const MARGIN_LEFT  = 72;   // 1 inch
const MARGIN_RIGHT = 72;
const MARGIN_TOP   = 72;
const MARGIN_BOT   = 72;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

// ─── Typography ───────────────────────────────────────────────────────────────
const BODY_SIZE      = 11;
const FOOTNOTE_SIZE  = 8;
const SUPERSCRIPT_SIZE = 7;   // inline reference number
const LINE_HEIGHT    = BODY_SIZE * 1.4;
const FN_LINE_HEIGHT = FOOTNOTE_SIZE * 1.4;

// Vertical gap between last body line and separator
const SEP_GAP   = 8;
// Vertical gap between separator and first footnote line
const FN_GAP    = 6;
// Height of the separator line area (gap above + 1pt rule + gap below)
const SEP_TOTAL = SEP_GAP + 1 + FN_GAP;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Measure the height in points needed to render a block of footnotes.
 * Returns 0 if footnotes array is empty.
 */
function footnoteBlockHeight(footnotes, font) {
  if (!footnotes || footnotes.length === 0) return 0;

  let lines = 0;
  for (const fn of footnotes) {
    const label  = `${fn.number}  `;
    const indent = font.widthOfTextAtSize(label, FOOTNOTE_SIZE);
    const body   = `${fn.number}  ${fn.text}`;
    lines += Math.ceil(font.widthOfTextAtSize(fn.text, FOOTNOTE_SIZE) / (CONTENT_WIDTH - indent)) || 1;
  }
  return SEP_TOTAL + lines * FN_LINE_HEIGHT + FN_GAP;
}

/**
 * Wrap a string into lines that fit within maxWidth at fontSize.
 * Returns string[].
 */
function wrapText(text, font, fontSize, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/**
 * Split body text on [FNx] markers.
 * Returns an array of segments: { text: string, fnNumber: number|null }
 * where fnNumber is set on the segment that *follows* the marker position,
 * i.e. the superscript is drawn at the end of that segment.
 *
 * Example: "See exhibit[FN3] for details" →
 *   [{ text: "See exhibit", fnNumber: 3 }, { text: " for details", fnNumber: null }]
 */
function parseInlineMarkers(text) {
  const parts = [];
  const re = /\[FN(\d+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    parts.push({ text: text.slice(last, m.index), fnNumber: parseInt(m[1], 10) });
    last = m.index + m[0].length;
  }
  parts.push({ text: text.slice(last), fnNumber: null });
  return parts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract plain text from a PDF buffer.
 * Falls back gracefully if pdf-parse fails.
 */
async function extractText(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    return {
      text: data.text || '',
      pageCount: data.numpages || 1
    };
  } catch (err) {
    console.error('pdf.js extractText error:', err.message);
    return { text: '', pageCount: 0 };
  }
}

/**
 * Build a translated PDF from body text and footnotes.
 *
 * @param {string}   translatedText   Body text with inline [FNx] markers.
 * @param {string}   originalFilename Used only for the PDF title metadata.
 * @param {Array}    footnotes        [{ number, text }, ...] — may be empty/null.
 * @returns {Buffer} PDF bytes.
 */
async function createPdfFromText(translatedText, originalFilename, footnotes) {
	
  footnotes = footnotes || [];
console.log('=== PDF.JS V2 EXECUTING - createPdfFromText called with', footnotes?.length || 0, 'footnotes ===');
  // ── Load font ──────────────────────────────────────────────────────────────
  let fontBytes;
  try {
    fontBytes = fs.readFileSync(FONT_PATH);
  } catch (e) {
    throw new Error(
      `pdf.js: Cannot read font file at "${FONT_PATH}". ` +
      `Run: apt install fonts-liberation  or update FONT_PATH in server/utils/pdf.js`
    );
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(fontBytes);

  pdfDoc.setTitle(originalFilename || 'Translation');
  pdfDoc.setCreator('TranslationService');

  // ── Paragraph splitting ────────────────────────────────────────────────────
  const paragraphs = translatedText
    .split(/\n{2,}/)
    .map(p => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);

  // Pre-calculate footnote block height (same on every page that has notes)
  const fnBlockH = footnoteBlockHeight(footnotes, font);

  // Usable body height per page
  const bodyMaxY   = PAGE_HEIGHT - MARGIN_TOP;
  const bodyMinY   = MARGIN_BOT + fnBlockH;   // leave room for footnotes
  const bodyHeight = bodyMaxY - bodyMinY;

  // ── Render loop ────────────────────────────────────────────────────────────
  let page        = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let cursorY     = bodyMaxY;
  let isFirstPage = true;
let pageFootnotes = new Set();  // Track footnote numbers on current page
  /**
   * Draw footnotes anchored to the bottom of the current page.
   * Called once per page just before we move to a new page.
   */
  
    function drawFootnotesOnPage(pg, pageSpecificFootnotes) {
  if (!pageSpecificFootnotes || pageSpecificFootnotes.length === 0) return;
    // Separator line position
    const sepY = MARGIN_BOT + fnBlockH - SEP_GAP;

    // Draw 1pt horizontal rule (72pt wide = 1 inch, matching Word style)
    pg.drawLine({
      start: { x: MARGIN_LEFT, y: sepY },
      end:   { x: MARGIN_LEFT + 72, y: sepY },
      thickness: 0.75,
      color: rgb(0, 0, 0)
    });

    let fnY = sepY - FN_GAP - FN_LINE_HEIGHT;

for (const fn of pageSpecificFootnotes) {
  const label      = `${fn.number}  `;
  const labelWidth = font.widthOfTextAtSize(label, FOOTNOTE_SIZE);
  const wrapWidth  = CONTENT_WIDTH - labelWidth;
  const lines      = wrapText(fn.text, font, FOOTNOTE_SIZE, wrapWidth);

  // Superscript-style number
  pg.drawText(String(fn.number), {
        x: MARGIN_LEFT,
        y: fnY + 2,   // raise slightly to mimic superscript
        size: SUPERSCRIPT_SIZE,
        font,
        color: rgb(0, 0, 0)
      });

      for (let li = 0; li < lines.length; li++) {
        pg.drawText(lines[li], {
          x: MARGIN_LEFT + labelWidth,
          y: fnY,
          size: FOOTNOTE_SIZE,
          font,
          color: rgb(0, 0, 0)
        });
        fnY -= FN_LINE_HEIGHT;
      }
    }
  }

  /**
   * Start a new page, draw footnotes on the old one first.
   */
  function newPage() {
  // Only draw footnotes that appeared on this page
  const footnotesForThisPage = footnotes.filter(fn => 
    pageFootnotes.has(parseInt(fn.number))
  );
  drawFootnotesOnPage(page, footnotesForThisPage);
  pageFootnotes.clear();  // Reset for next page
  page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  cursorY = bodyMaxY;
}

  // ── Draw body paragraphs ───────────────────────────────────────────────────
  for (const para of paragraphs) {
    // Blank line between paragraphs
    if (!isFirstPage) {
      cursorY -= LINE_HEIGHT * 0.5;
      if (cursorY < bodyMinY) newPage();
    }
    isFirstPage = false;

    // Split paragraph into segments (plain text + optional inline FN marker)
    const segments = parseInlineMarkers(para);

    // Build word-level token stream so we can wrap properly across segments
    // Each token: { word: string, fnAfter: number|null }
    const tokens = [];
    for (const seg of segments) {
      const words = seg.text.split(' ').filter(w => w.length > 0);
      for (let wi = 0; wi < words.length; wi++) {
        const isLast = wi === words.length - 1;
        tokens.push({
          word:    words[wi],
          fnAfter: (isLast && seg.fnNumber != null) ? seg.fnNumber : null
        });
      }
    }

    // Wrap tokens into lines
    const lineTokens = [];
    let   currentLine = [];
    let   currentWidth = 0;

    for (const tok of tokens) {
      const wordW = font.widthOfTextAtSize(tok.word, BODY_SIZE);
      const spaceW = currentLine.length ? font.widthOfTextAtSize(' ', BODY_SIZE) : 0;
      const supW   = tok.fnAfter != null
        ? font.widthOfTextAtSize(String(tok.fnAfter), SUPERSCRIPT_SIZE) + 1
        : 0;
      const needed = spaceW + wordW + supW;

      if (currentWidth + needed > CONTENT_WIDTH && currentLine.length > 0) {
        lineTokens.push(currentLine);
        currentLine  = [tok];
        currentWidth = wordW + supW;
      } else {
        currentLine.push(tok);
        currentWidth += needed;
      }
    }
    if (currentLine.length) lineTokens.push(currentLine);

    // Draw each line
    for (const lineArr of lineTokens) {
      if (cursorY < bodyMinY) newPage();

      let x = MARGIN_LEFT;
      for (let ti = 0; ti < lineArr.length; ti++) {
        const tok = lineArr[ti];

        // Space before word (not first word on line)
        if (ti > 0) {
          x += font.widthOfTextAtSize(' ', BODY_SIZE);
        }

        // Draw word
        page.drawText(tok.word, {
          x,
          y: cursorY,
          size: BODY_SIZE,
          font,
          color: rgb(0, 0, 0)
        });
        x += font.widthOfTextAtSize(tok.word, BODY_SIZE);

        // Draw superscript reference number if this word carries one
        if (tok.fnAfter != null) {
			pageFootnotes.add(tok.fnAfter);  // Track this footnote for current page
          page.drawText(String(tok.fnAfter), {
            x,
            y: cursorY + 3,   // raise 3pt above baseline
            size: SUPERSCRIPT_SIZE,
            font,
            color: rgb(0, 0, 0)
          });
          x += font.widthOfTextAtSize(String(tok.fnAfter), SUPERSCRIPT_SIZE) + 1;
        }
      }

      cursorY -= LINE_HEIGHT;
    }
  }

  // Draw footnotes on the final page
  const footnotesForThisPage = footnotes.filter(fn => 
  pageFootnotes.has(parseInt(fn.number))
);
drawFootnotesOnPage(page, footnotesForThisPage);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { extractText, createPdfFromText };
