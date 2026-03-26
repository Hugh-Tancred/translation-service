'use strict';

/**
 * word.js — Word document generation utility
 *
 * Exports:
 *   createWordFromText(text, filename, footnotes) → Buffer
 *
 * Body text conventions (prefixes stripped before rendering):
 *   ##TITLE##    → Heading 1, bold, large, centred
 *   ##HEADING##  → Heading 2, bold, visually distinct subheading
 *   ##LISTITEM## → Reference list item (already numbered by wordExtract)
 *   ### text     → Heading 3 (markdown fallback)
 *   - text       → Bullet point
 *   | col | col  → Markdown table → rendered as Word table
 *   Inline [FN1] markers → Word footnote references
 *
 * Pattern-detected structure (no prefix required):
 *   Roman numeral section title  e.g. "I.", "II.", "III."  → centred bold section head
 *   Numbered clause heading      e.g. "1.  Company Name"   → bold clause head
 *   Sub-clause                   e.g. "(1) The company..."  → indented body
 *   Sub-sub-clause               e.g. "a) From the..."      → further indented body
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  FootnoteReferenceRun,
  HeadingLevel,
  AlignmentType,
  convertInchesToTwip,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} = require('docx');

// ─── Structural pattern detectors ────────────────────────────────────────────

const RE_ROMAN_SECTION   = /^((?:X{0,3})(IX|IV|V?I{0,3}))\.?\s*$/i;
const RE_ROMAN_WITH_TEXT = /^((?:X{0,3})(?:IX|IV|V?I{0,3}))\.\s+(.+)$/i;
const RE_CLAUSE_HEADING  = /^(\d+)\.\s{1,4}([A-ZÄÖÜ].*)$/;
const RE_SUBCLAUSE       = /^\((\d+)\)\s+/;
const RE_SUBSUBCLAUSE    = /^([a-z])\)\s+/;

// ─── Inline marker parser ─────────────────────────────────────────────────────

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

function buildChildren(text, footnoteMap, runOptions) {
  const segments = parseInlineMarkers(text);
  const children = [];
  for (const seg of segments) {
    if (seg.text) {
      children.push(new TextRun(Object.assign({ text: seg.text }, runOptions)));
    }
    if (seg.fnNumber != null && footnoteMap[seg.fnNumber] !== undefined) {
      children.push(new FootnoteReferenceRun(seg.fnNumber));
    }
  }
  return children;
}

// ─── Table parser ─────────────────────────────────────────────────────────────

function isTableBlock(paragraphs, startIndex) {
  return paragraphs[startIndex] && paragraphs[startIndex].startsWith('|');
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

// ─── Main export ──────────────────────────────────────────────────────────────

async function createWordFromText(translatedText, originalFilename, footnotes) {
  footnotes = footnotes || [];

  const footnoteMap = {};
  for (const fn of footnotes) {
    footnoteMap[parseInt(fn.number)] = fn.text;
  }

  const docxFootnotes = {};
  for (const fn of footnotes) {
    const num = parseInt(fn.number);
    docxFootnotes[num] = {
      children: [
        new Paragraph({
          children: [new TextRun({ text: fn.text, size: 18 })]
        })
      ]
    };
  }

  const paragraphs = translatedText
    .split(/\n/)
    .map(function(p) { return p.trim(); })
    .filter(Boolean);

  const docParagraphs = [];

  let i = 0;
  while (i < paragraphs.length) {
    const para = paragraphs[i];

    // ── Markdown table ────────────────────────────────────────────────────────
    if (isTableBlock(paragraphs, i)) {
      const { rows, nextIndex } = parseMarkdownTable(paragraphs, i);
      i = nextIndex;

      if (rows.length === 0) continue;

      const colCount = Math.max(...rows.map(r => r.length));
      const tableWidth = 9026; // A4 content width in DXA
      const colWidth = Math.floor(tableWidth / colCount);

      const border = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
      const borders = { top: border, bottom: border, left: border, right: border };

      const tableRows = rows.map((row, rowIndex) => {
        const isHeader = rowIndex === 0;
        const cells = [];
        for (let c = 0; c < colCount; c++) {
          const cellText = row[c] || '';
          cells.push(new TableCell({
            borders,
            width: { size: colWidth, type: WidthType.DXA },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [new Paragraph({
              children: [new TextRun({
                text: cellText,
                bold: isHeader,
                size: 20,
              })]
            })]
          }));
        }
        return new TableRow({ children: cells });
      });

      docParagraphs.push(new Table({
        width: { size: tableWidth, type: WidthType.DXA },
        columnWidths: Array(colCount).fill(colWidth),
        rows: tableRows,
      }));

      // Spacing after table
      docParagraphs.push(new Paragraph({ spacing: { after: 160 } }));
      continue;
    }

    // ── ##TITLE## → Heading 1, bold, large, centred ──────────────────────────
    if (para.startsWith('##TITLE## ')) {
      const text = para.slice(10).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 36 }),
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 360, after: 160 }
      }));
      i++;
      continue;
    }

    // ── ##HEADING## → Heading 2, bold, left-aligned or centred if Roman ──────
    if (para.startsWith('##HEADING## ')) {
      const text = para.slice(12).trim();
      const isRoman = RE_ROMAN_SECTION.test(text) || RE_ROMAN_WITH_TEXT.test(text);
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 28 }),
        heading: HeadingLevel.HEADING_2,
        alignment: isRoman ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { before: 280, after: 120 }
      }));
      i++;
      continue;
    }

    // ── ##LISTITEM## → reference list item ───────────────────────────────────
    if (para.startsWith('##LISTITEM## ')) {
      const text = para.slice(13).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { size: 20 }),
        spacing: { after: 60 }
      }));
      i++;
      continue;
    }

    // ── ### markdown heading → Heading 3 ─────────────────────────────────────
    if (para.startsWith('### ')) {
      const text = para.slice(4).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 24 }),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 240, after: 100 }
      }));
      i++;
      continue;
    }

    // ── Bullet point ─────────────────────────────────────────────────────────
    if (para.startsWith('- ')) {
      const text = para.slice(2).trim();
      docParagraphs.push(new Paragraph({
        children: [new TextRun({ text: text, size: 22 })],
        bullet: { level: 0 },
        spacing: { after: 100 }
      }));
      i++;
      continue;
    }

    // ── Roman numeral section title (standalone): "I.", "II." etc. ───────────
    if (RE_ROMAN_SECTION.test(para)) {
      docParagraphs.push(new Paragraph({
        children: [new TextRun({ text: para, bold: true, size: 26 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 320, after: 80 }
      }));
      i++;
      continue;
    }

    // ── Roman numeral section title with inline text: "I. General Provisions" ─
    const romanMatch = para.match(RE_ROMAN_WITH_TEXT);
    if (romanMatch) {
      docParagraphs.push(new Paragraph({
        children: [
          new TextRun({ text: romanMatch[1] + '.  ', bold: true, size: 26 }),
          ...buildChildren(romanMatch[2], footnoteMap, { bold: true, size: 26 })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 320, after: 80 }
      }));
      i++;
      continue;
    }

    // ── Numbered clause heading: "1.  Company Name, Registered Office" ────────
    const clauseMatch = para.match(RE_CLAUSE_HEADING);
    if (clauseMatch) {
      docParagraphs.push(new Paragraph({
        children: [
          new TextRun({ text: clauseMatch[1] + '.  ', bold: true, size: 24 }),
          ...buildChildren(clauseMatch[2], footnoteMap, { bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 80 }
      }));
      i++;
      continue;
    }

    // ── Sub-clause: "(1) The company is..." → indented, justified ───────────
    if (RE_SUBCLAUSE.test(para)) {
      docParagraphs.push(new Paragraph({
        children: buildChildren(para, footnoteMap, { size: 22 }),
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: convertInchesToTwip(0.4) },
        spacing: { after: 100 }
      }));
      i++;
      continue;
    }

    // ── Sub-sub-clause: "a) From the liquidation..." → further indented ───────
    if (RE_SUBSUBCLAUSE.test(para)) {
      docParagraphs.push(new Paragraph({
        children: buildChildren(para, footnoteMap, { size: 22 }),
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: convertInchesToTwip(0.7) },
        spacing: { after: 100 }
      }));
      i++;
      continue;
    }

    // ── Standard paragraph → justified ───────────────────────────────────────
    docParagraphs.push(new Paragraph({
      children: buildChildren(para, footnoteMap, { size: 22 }),
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 160 }
    }));
    i++;
  }

  const doc = new Document({
    title: originalFilename || 'Translation',
    creator: 'TranslationService',
    footnotes: docxFootnotes,
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(1),
            bottom: convertInchesToTwip(1),
            left: convertInchesToTwip(1.1),
            right: convertInchesToTwip(1.1)
          }
        }
      },
      children: docParagraphs
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

module.exports = { createWordFromText };
