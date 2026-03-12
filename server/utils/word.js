'use strict';

/**
 * word.js — Word document generation utility
 *
 * Exports:
 *   createWordFromText(text, filename, footnotes) → Buffer
 *
 * Body text conventions (prefixes stripped before rendering):
 *   ##TITLE##    → Heading 1, bold, large
 *   ##HEADING##  → Bold italic subheading
 *   ##LISTITEM## → Reference list item (already numbered by wordExtract)
 *   ### text     → Heading 2
 *   - text       → Bullet point
 *   Inline [FN1] markers → Word footnote references
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  FootnoteReferenceRun,
  HeadingLevel,
  convertInchesToTwip,
} = require('docx');

// Split a string on [FNx] markers into segments
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

// Build TextRun/FootnoteReferenceRun children from a string
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

async function createWordFromText(translatedText, originalFilename, footnotes) {
  footnotes = footnotes || [];

  // Footnote lookup map
  const footnoteMap = {};
  for (const fn of footnotes) {
    footnoteMap[parseInt(fn.number)] = fn.text;
  }

  // Build docx footnotes object
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

  // Split into paragraphs
  const paragraphs = translatedText
    .split(/\n/)
    .map(function(p) { return p.trim(); })
    .filter(Boolean);

  const docParagraphs = [];

  for (const para of paragraphs) {

    // ── Title (Heading 1) ───────────────────────────────────────────────────
    if (para.startsWith('##TITLE## ')) {
      const text = para.slice(10).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 32 }),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 }
      }));
      continue;
    }

    // ── Subheading ──────────────────────────────────────────────────────────
    if (para.startsWith('##HEADING## ')) {
      const text = para.slice(12).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { bold: true, size: 24 }),
        spacing: { before: 200, after: 80 }
      }));
      continue;
    }

    // ── Reference list item (numbered by wordExtract) ───────────────────────
    if (para.startsWith('##LISTITEM## ')) {
      const text = para.slice(13).trim();
      docParagraphs.push(new Paragraph({
        children: buildChildren(text, footnoteMap, { size: 20 }),
        spacing: { after: 60 }
      }));
      continue;
    }

    // ── Markdown heading (### ) ─────────────────────────────────────────────
    if (para.startsWith('### ')) {
      const text = para.slice(4).trim();
      docParagraphs.push(new Paragraph({
        text: text,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 }
      }));
      continue;
    }

    // ── Bullet point ────────────────────────────────────────────────────────
    if (para.startsWith('- ')) {
      const text = para.slice(2).trim();
      docParagraphs.push(new Paragraph({
        children: [new TextRun({ text: text, size: 24 })],
        bullet: { level: 0 },
        spacing: { after: 100 }
      }));
      continue;
    }

    // ── Numbered list item ──────────────────────────────────────────────────
    if (/^\d+\.\s/.test(para)) {
      const segments = parseInlineMarkers(para);
      const children = [];
      for (const seg of segments) {
        if (seg.text) children.push(new TextRun({ text: seg.text, size: 24 }));
        if (seg.fnNumber != null && footnoteMap[seg.fnNumber] !== undefined) {
          children.push(new FootnoteReferenceRun(seg.fnNumber));
        }
      }
      docParagraphs.push(new Paragraph({
        children,
        spacing: { after: 100 }
      }));
      continue;
    }

    // ── Standard paragraph ──────────────────────────────────────────────────
    docParagraphs.push(new Paragraph({
      children: buildChildren(para, footnoteMap, { size: 24 }),
      spacing: { after: 200 }
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
            left: convertInchesToTwip(1),
            right: convertInchesToTwip(1)
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
