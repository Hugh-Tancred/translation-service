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
} = require('docx');

// ─── Structural pattern detectors ────────────────────────────────────────────

// Roman numeral section title: line is ONLY a roman numeral + optional period
// e.g. "I.", "II.", "III.", "IV.", "V."
// Followed on the next paragraph by the section title text — but we handle
// each paragraph independently, so we detect the combined form too:
// "I.\nGeneral Provisions" may arrive as two paras OR as "I. General Provisions"
const RE_ROMAN_SECTION = /^((?:X{0,3})(IX|IV|V?I{0,3}))\.?\s*$/i;

// Roman numeral section title with inline text: "I. General Provisions"
const RE_ROMAN_WITH_TEXT = /^((?:X{0,3})(?:IX|IV|V?I{0,3}))\.\s+(.+)$/i;

// Numbered clause heading: "1.  Company Name, Registered Office..."
// Distinguished from sub-clause "(1)" by the absence of parentheses.
// We require the text after the number to start with a capital letter.
const RE_CLAUSE_HEADING = /^(\d+)\.\s{1,4}([A-ZÄÖÜ].*)$/;

// Sub-clause: "(1) The company is..."
const RE_SUBCLAUSE = /^\((\d+)\)\s+/;

// Sub-sub-clause: "a) From the liquidation..."
const RE_SUBSUBCLAUSE = /^([a-z])\)\s+/;

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

  for (const para of paragraphs) {

    // ── ##TITLE## → Heading 1, bold, large, centred ──────────────────────────
    if (para.startsWith('##TITLE## ')) {
      const text = para.slice(10).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 36 }),
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { before: 360, after: 160 }
      }));
      continue;
    }

    // ── ##HEADING## → Heading 2, bold, centred ───────────────────────────────
    if (para.startsWith('##HEADING## ')) {
      const text = para.slice(12).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 28 }),
        heading: HeadingLevel.HEADING_2,
        alignment: AlignmentType.CENTER,
        spacing: { before: 280, after: 120 }
      }));
      continue;
    }

    // ── ##LISTITEM## → reference list item ───────────────────────────────────
    if (para.startsWith('##LISTITEM## ')) {
      const text = para.slice(13).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { size: 20 }),
        spacing: { after: 60 }
      }));
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
      continue;
    }

    // ── Roman numeral section title (standalone): "I.", "II." etc. ───────────
    if (RE_ROMAN_SECTION.test(para)) {
      docParagraphs.push(new Paragraph({
        children: [new TextRun({ text: para, bold: true, size: 26 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 320, after: 80 }
      }));
      continue;
    }

    // ── Roman numeral section title with inline text: "I. General Provisions" ─
    const romanMatch = para.match(RE_ROMAN_WITH_TEXT);
    if (romanMatch) {
      // Render as two runs: numeral bold + title bold, centred
      docParagraphs.push(new Paragraph({
        children: [
          new TextRun({ text: romanMatch[1] + '.  ', bold: true, size: 26 }),
          ...buildChildren(romanMatch[2], footnoteMap, { bold: true, size: 26 })
        ],
        alignment: AlignmentType.CENTER,
        spacing: { before: 320, after: 80 }
      }));
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
      continue;
    }

    // ── Standard paragraph → justified ───────────────────────────────────────
    docParagraphs.push(new Paragraph({
      children: buildChildren(para, footnoteMap, { size: 22 }),
      alignment: AlignmentType.JUSTIFIED,
      spacing: { after: 160 }
    }));
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
