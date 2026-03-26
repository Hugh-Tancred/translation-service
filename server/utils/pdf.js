'use strict';

/**
 * pdf.js  —  PDF extraction and reconstruction utility
 *
 * Exports:
 *   extractText(pdfBuffer)                          → { text, pageCount }
 *   createPdfFromText(text, filename, footnotes)    → Buffer
 *
 * Footnote contract:
 *   [{ number: 1, text: "Footnote body..." }, ...]
 *
 * Body text conventions:
 *   ##TITLE##    → document title: large, bold font, centred
 *   ##HEADING##  → subheading: medium-large, bold font, centred
 *   ##LISTITEM## → reference list item, body size
 *   | col | col  → markdown table → rendered as PDF table
 *   Inline [FN1] markers → superscript reference numbers
 *
 * Pattern-detected structure (no prefix required):
 *   Roman numeral section  e.g. "I. General Provisions" → centred bold
 *   Numbered clause        e.g. "1.  Company Name"       → bold, spaced
 *   Sub-clause             e.g. "(1) The company..."      → indented
 *   Sub-sub-clause         e.g. "a) From the..."          → further indented
 *
 * Font requirement:
 *   Regular: fonts/LiberationSans-Regular.ttf  (required)
 *   Bold:    fonts/LiberationSans-Bold.ttf     (optional — falls back to Helvetica-Bold)
 *   Install: apt install fonts-liberation
 */

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

// ─── Font paths ───────────────────────────────────────────────────────────────
const FONT_PATH      = path.join(__dirname, '../../fonts/LiberationSans-Regular.ttf');
const FONT_BOLD_PATH = path.join(__dirname, '../../fonts/LiberationSans-Bold.ttf');

// ─── Page geometry (A4 in points, 72pt = 1 inch) ─────────────────────────────
const PAGE_WIDTH   = 595.28;
const PAGE_HEIGHT  = 841.89;
const MARGIN_LEFT  = 72;
const MARGIN_RIGHT = 72;
const MARGIN_TOP   = 72;
const MARGIN_BOT   = 72;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

// ─── Typography ───────────────────────────────────────────────────────────────
const TITLE_SIZE       = 18;
const SECTION_SIZE     = 14;
const HEADING_SIZE     = 13;
const CLAUSE_SIZE      = 12;
const BODY_SIZE        = 11;
const LISTITEM_SIZE    = 10;
const TABLE_SIZE       = 9;
const FOOTNOTE_SIZE    = 8;
const SUPERSCRIPT_SIZE = 7;

const TITLE_LINE_HEIGHT   = TITLE_SIZE   * 1.4;
const SECTION_LINE_HEIGHT = SECTION_SIZE * 1.4;
const HEADING_LINE_HEIGHT = HEADING_SIZE * 1.4;
const LINE_HEIGHT         = BODY_SIZE    * 1.4;
const FN_LINE_HEIGHT      = FOOTNOTE_SIZE * 1.4;

// Indents for sub-clauses
const INDENT_SUBCLAUSE    = 28;   // points (~0.4 inch)
const INDENT_SUBSUBCLAUSE = 50;   // points (~0.7 inch)

// Vertical gap between last body line and separator
const SEP_GAP   = 8;
const FN_GAP    = 6;
const SEP_TOTAL = SEP_GAP + 1 + FN_GAP;

// ─── Structural pattern detectors ────────────────────────────────────────────
const RE_ROMAN_SECTION   = /^((?:X{0,3})(?:IX|IV|V?I{0,3}))\.?\s*$/i;
const RE_ROMAN_WITH_TEXT = /^((?:X{0,3})(?:IX|IV|V?I{0,3}))\.\s+(.+)$/i;
const RE_CLAUSE_HEADING  = /^(\d+)\.\s{1,4}([A-ZÄÖÜ].*)/;
const RE_SUBCLAUSE       = /^\(\d+\)\s+/;
const RE_SUBSUBCLAUSE    = /^[a-z]\)\s+/;

// ─── Module-level helpers (no page state needed) ──────────────────────────────

function footnoteBlockHeight(footnotes, font) {
  if (!footnotes || footnotes.length === 0) return 0;
  let lines = 0;
  for (const fn of footnotes) {
    const label  = `${fn.number}  `;
    const indent = font.widthOfTextAtSize(label, FOOTNOTE_SIZE);
    lines += Math.ceil(font.widthOfTextAtSize(fn.text, FOOTNOTE_SIZE) / (CONTENT_WIDTH - indent)) || 1;
  }
  return SEP_TOTAL + lines * FN_LINE_HEIGHT + FN_GAP;
}

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

function parseMarkdownTable(paragraphs, startIndex) {
  const rows = [];
  let i = startIndex;
  while (i < paragraphs.length && paragraphs[i].startsWith('|')) {
    const line = paragraphs[i];
    // Skip separator rows e.g. |---|---|
    if (/^\|[-| :]+\|$/.test(line)) {
      i++;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map(c => c.trim());
    rows.push(cells);
    i++;
  }
  return { rows, nextIndex: i };
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function extractText(pdfBuffer) {
  try {
    const data = await pdfParse(pdfBuffer);
    return { text: data.text || '', pageCount: data.numpages || 1 };
  } catch (err) {
    console.error('pdf.js extractText error:', err.message);
    return { text: '', pageCount: 0 };
  }
}

async function createPdfFromText(translatedText, originalFilename, footnotes) {
  footnotes = footnotes || [];
  console.log('=== PDF.JS V4 EXECUTING - createPdfFromText called with', footnotes?.length || 0, 'footnotes ===');

  // ── Load fonts ────────────────────────────────────────────────────────────
  let fontBytes;
  try {
    fontBytes = fs.readFileSync(FONT_PATH);
  } catch (e) {
    throw new Error(
      `pdf.js: Cannot read font file at "${FONT_PATH}". ` +
      `Run: apt install fonts-liberation  or update FONT_PATH in server/utils/pdf.js`
    );
  }

  let fontBoldBytes = null;
  try {
    fontBoldBytes = fs.readFileSync(FONT_BOLD_PATH);
  } catch (e) {
    console.warn('pdf.js: Bold font not found at', FONT_BOLD_PATH, '— falling back to Helvetica-Bold');
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font     = await pdfDoc.embedFont(fontBytes);
  const fontBold = fontBoldBytes
    ? await pdfDoc.embedFont(fontBoldBytes)
    : await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  pdfDoc.setTitle(originalFilename || 'Translation');
  pdfDoc.setCreator('TranslationService');

  // ── Paragraph splitting ───────────────────────────────────────────────────
  const paragraphs = translatedText
    .split(/\n{1,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const fnBlockH  = footnoteBlockHeight(footnotes, font);
  const bodyMaxY  = PAGE_HEIGHT - MARGIN_TOP;
  const bodyMinY  = MARGIN_BOT + fnBlockH;

  let page          = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let cursorY       = bodyMaxY;
  let isFirstPage   = true;
  let pageFootnotes = new Set();

  // ── Footnote drawer ───────────────────────────────────────────────────────
  function drawFootnotesOnPage(pg, pageSpecificFootnotes) {
    if (!pageSpecificFootnotes || pageSpecificFootnotes.length === 0) return;
    const sepY = MARGIN_BOT + fnBlockH - SEP_GAP;
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
      const lines      = wrapText(fn.text, font, FOOTNOTE_SIZE, CONTENT_WIDTH - labelWidth);
      pg.drawText(String(fn.number), {
        x: MARGIN_LEFT, y: fnY + 2, size: SUPERSCRIPT_SIZE, font, color: rgb(0, 0, 0)
      });
      for (const line of lines) {
        pg.drawText(line, {
          x: MARGIN_LEFT + labelWidth, y: fnY, size: FOOTNOTE_SIZE, font, color: rgb(0, 0, 0)
        });
        fnY -= FN_LINE_HEIGHT;
      }
    }
  }

  function newPage() {
    const footnotesForThisPage = footnotes.filter(fn => pageFootnotes.has(parseInt(fn.number)));
    drawFootnotesOnPage(page, footnotesForThisPage);
    pageFootnotes.clear();
    page    = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    cursorY = bodyMaxY;
  }

  // ── Table renderer ────────────────────────────────────────────────────────
  function drawTable(rows) {
    if (rows.length === 0) return;

    const colCount  = Math.max(...rows.map(r => r.length));
    const colWidth  = CONTENT_WIDTH / colCount;
    const cellPadX  = 4;
    const cellPadY  = 4;

    // Calculate the height of each row based on its tallest cell
    const rowHeights = rows.map((row, rowIndex) => {
      const useFont  = rowIndex === 0 ? fontBold : font;
      let maxLines   = 1;
      for (let c = 0; c < colCount; c++) {
        const cellText = row[c] || '';
        const lines    = wrapText(cellText, useFont, TABLE_SIZE, colWidth - cellPadX * 2);
        if (lines.length > maxLines) maxLines = lines.length;
      }
      return TABLE_SIZE * 1.4 * maxLines + cellPadY * 2;
    });

    const totalHeight = rowHeights.reduce((a, b) => a + b, 0);

    // If the whole table fits on the current page, keep it together;
    // otherwise start a new page
    if (cursorY - totalHeight < bodyMinY) newPage();

    for (let r = 0; r < rows.length; r++) {
      const row       = rows[r];
      const isHeader  = r === 0;
      const useFont   = isHeader ? fontBold : font;
      const rowHeight = rowHeights[r];
      const rowBottom = cursorY - rowHeight;

      for (let c = 0; c < colCount; c++) {
        const cellX    = MARGIN_LEFT + c * colWidth;
        const cellText = row[c] || '';

        // Cell background and border
        page.drawRectangle({
          x:           cellX,
          y:           rowBottom,
          width:       colWidth,
          height:      rowHeight,
          borderColor: rgb(0.6, 0.6, 0.6),
          borderWidth: 0.5,
          color:       isHeader ? rgb(0.93, 0.93, 0.93) : rgb(1, 1, 1),
        });

        // Cell text
        const maxCellWidth = colWidth - cellPadX * 2;
        const lines        = wrapText(cellText, useFont, TABLE_SIZE, maxCellWidth);
        let textY          = cursorY - cellPadY - TABLE_SIZE;
        for (const line of lines) {
          page.drawText(line, {
            x:    cellX + cellPadX,
            y:    textY,
            size: TABLE_SIZE,
            font: useFont,
            color: rgb(0, 0, 0),
          });
          textY -= TABLE_SIZE * 1.4;
        }
      }

      cursorY     = rowBottom;
      isFirstPage = false;
    }

    // Space after table
    cursorY -= LINE_HEIGHT * 0.6;
  }

  // ── Generic line renderer ─────────────────────────────────────────────────
  function drawParagraph(text, opts) {
    const {
      fontSize    = BODY_SIZE,
      lineHeight  = LINE_HEIGHT,
      useFont     = font,
      leftMargin  = MARGIN_LEFT,
      maxWidth    = CONTENT_WIDTH,
      spaceBefore = 0,
      spaceAfter  = LINE_HEIGHT * 0.4,
      centered    = false,
    } = opts || {};

    if (!isFirstPage && spaceBefore > 0) {
      cursorY -= spaceBefore;
      if (cursorY < bodyMinY) newPage();
    }

    const segments = parseInlineMarkers(text);
    const tokens = [];
    for (const seg of segments) {
      const words = seg.text.split(' ').filter(w => w.length > 0);
      for (let wi = 0; wi < words.length; wi++) {
        tokens.push({
          word:    words[wi],
          fnAfter: (wi === words.length - 1 && seg.fnNumber != null) ? seg.fnNumber : null
        });
      }
    }

    const lineTokens = [];
    let currentLine  = [];
    let currentWidth = 0;
    for (const tok of tokens) {
      const wordW  = useFont.widthOfTextAtSize(tok.word, fontSize);
      const spaceW = currentLine.length ? useFont.widthOfTextAtSize(' ', fontSize) : 0;
      const supW   = tok.fnAfter != null
        ? font.widthOfTextAtSize(String(tok.fnAfter), SUPERSCRIPT_SIZE) + 1 : 0;
      const needed = spaceW + wordW + supW;
      if (currentWidth + needed > maxWidth && currentLine.length > 0) {
        lineTokens.push(currentLine);
        currentLine  = [tok];
        currentWidth = wordW + supW;
      } else {
        currentLine.push(tok);
        currentWidth += needed;
      }
    }
    if (currentLine.length) lineTokens.push(currentLine);

    for (const lineArr of lineTokens) {
      if (cursorY < bodyMinY) newPage();

      let lineWidth = 0;
      if (centered) {
        for (let ti = 0; ti < lineArr.length; ti++) {
          if (ti > 0) lineWidth += useFont.widthOfTextAtSize(' ', fontSize);
          lineWidth += useFont.widthOfTextAtSize(lineArr[ti].word, fontSize);
          if (lineArr[ti].fnAfter != null) {
            lineWidth += font.widthOfTextAtSize(String(lineArr[ti].fnAfter), SUPERSCRIPT_SIZE) + 1;
          }
        }
      }

      let x = centered
        ? MARGIN_LEFT + (maxWidth - lineWidth) / 2
        : leftMargin;

      for (let ti = 0; ti < lineArr.length; ti++) {
        const tok = lineArr[ti];
        if (ti > 0) x += useFont.widthOfTextAtSize(' ', fontSize);
        page.drawText(tok.word, { x, y: cursorY, size: fontSize, font: useFont, color: rgb(0, 0, 0) });
        x += useFont.widthOfTextAtSize(tok.word, fontSize);
        if (tok.fnAfter != null) {
          pageFootnotes.add(tok.fnAfter);
          page.drawText(String(tok.fnAfter), {
            x, y: cursorY + 3, size: SUPERSCRIPT_SIZE, font, color: rgb(0, 0, 0)
          });
          x += font.widthOfTextAtSize(String(tok.fnAfter), SUPERSCRIPT_SIZE) + 1;
        }
      }
      cursorY -= lineHeight;
      isFirstPage = false;
    }

    if (spaceAfter > 0) {
      cursorY -= spaceAfter;
      if (cursorY < bodyMinY) newPage();
    }
  }

  // ── Draw body paragraphs ─────────────────────────────────────────────────
  let i = 0;
  while (i < paragraphs.length) {
    const para = paragraphs[i];

    // ── Markdown table ────────────────────────────────────────────────────────
    if (para.startsWith('|')) {
      const { rows, nextIndex } = parseMarkdownTable(paragraphs, i);
      i = nextIndex;
      drawTable(rows);
      continue;
    }

    // ── ##TITLE## ────────────────────────────────────────────────────────────
    if (para.startsWith('##TITLE## ')) {
      const text = para.slice(10).trim();
      drawParagraph(text, {
        fontSize:    TITLE_SIZE,
        lineHeight:  TITLE_LINE_HEIGHT,
        useFont:     fontBold,
        spaceBefore: TITLE_LINE_HEIGHT,
        spaceAfter:  TITLE_LINE_HEIGHT * 0.6,
        centered:    true,
      });
      i++;
      continue;
    }

    // ── ##HEADING## ──────────────────────────────────────────────────────────
    if (para.startsWith('##HEADING## ')) {
      const text = para.slice(12).trim();
      drawParagraph(text, {
        fontSize:    HEADING_SIZE,
        lineHeight:  HEADING_LINE_HEIGHT,
        useFont:     fontBold,
        spaceBefore: HEADING_LINE_HEIGHT * 1.4,
        spaceAfter:  HEADING_LINE_HEIGHT * 0.5,
        centered:    true,
      });
      i++;
      continue;
    }

    // ── ##LISTITEM## ─────────────────────────────────────────────────────────
    if (para.startsWith('##LISTITEM## ')) {
      const text = para.slice(13).trim();
      drawParagraph(text, {
        fontSize:    LISTITEM_SIZE,
        lineHeight:  LISTITEM_SIZE * 1.4,
        spaceAfter:  4,
      });
      i++;
      continue;
    }

    // ── Roman numeral section (standalone): "I.", "IV." etc. ─────────────────
    if (RE_ROMAN_SECTION.test(para)) {
      drawParagraph(para, {
        fontSize:    SECTION_SIZE,
        lineHeight:  SECTION_LINE_HEIGHT,
        useFont:     fontBold,
        spaceBefore: SECTION_LINE_HEIGHT * 1.2,
        spaceAfter:  SECTION_LINE_HEIGHT * 0.3,
        centered:    true,
      });
      i++;
      continue;
    }

    // ── Roman numeral section with inline title: "I. General Provisions" ──────
    const romanMatch = para.match(RE_ROMAN_WITH_TEXT);
    if (romanMatch) {
      drawParagraph(romanMatch[1] + '.  ' + romanMatch[2], {
        fontSize:    SECTION_SIZE,
        lineHeight:  SECTION_LINE_HEIGHT,
        useFont:     fontBold,
        spaceBefore: SECTION_LINE_HEIGHT * 1.2,
        spaceAfter:  SECTION_LINE_HEIGHT * 0.3,
        centered:    true,
      });
      i++;
      continue;
    }

    // ── Numbered clause heading: "1.  Company Name, Registered Office" ────────
    const clauseMatch = para.match(RE_CLAUSE_HEADING);
    if (clauseMatch) {
      drawParagraph(clauseMatch[1] + '.  ' + clauseMatch[2], {
        fontSize:    CLAUSE_SIZE,
        lineHeight:  LINE_HEIGHT,
        useFont:     fontBold,
        spaceBefore: LINE_HEIGHT * 1.0,
        spaceAfter:  LINE_HEIGHT * 0.3,
      });
      i++;
      continue;
    }

    // ── Sub-clause: "(1) The company is..." ───────────────────────────────────
    if (RE_SUBCLAUSE.test(para)) {
      drawParagraph(para, {
        leftMargin:  MARGIN_LEFT + INDENT_SUBCLAUSE,
        maxWidth:    CONTENT_WIDTH - INDENT_SUBCLAUSE,
        spaceBefore: LINE_HEIGHT * 0.2,
        spaceAfter:  LINE_HEIGHT * 0.3,
      });
      i++;
      continue;
    }

    // ── Sub-sub-clause: "a) From the liquidation..." ──────────────────────────
    if (RE_SUBSUBCLAUSE.test(para)) {
      drawParagraph(para, {
        leftMargin:  MARGIN_LEFT + INDENT_SUBSUBCLAUSE,
        maxWidth:    CONTENT_WIDTH - INDENT_SUBSUBCLAUSE,
        spaceBefore: LINE_HEIGHT * 0.2,
        spaceAfter:  LINE_HEIGHT * 0.3,
      });
      i++;
      continue;
    }

    // ── Standard paragraph ────────────────────────────────────────────────────
    drawParagraph(para, {
      spaceBefore: LINE_HEIGHT * 0.4,
      spaceAfter:  LINE_HEIGHT * 0.3,
    });
    i++;
  }

  // Draw footnotes on final page
  const footnotesForFinalPage = footnotes.filter(fn => pageFootnotes.has(parseInt(fn.number)));
  drawFootnotesOnPage(page, footnotesForFinalPage);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = { extractText, createPdfFromText };
