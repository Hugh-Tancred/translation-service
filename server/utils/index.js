'use strict';

/**
 * word.js  —  Word document generation utility
 *
 * Exports:
 *   createWordFromText(text, filename, footnotes)  → Buffer
 *
 * Footnote contract (footnotes array):
 *   [{ number: 1, text: "Footnote body..." }, ...]
 *
 * Body text convention:
 *   Inline markers look like [FN1], [FN2] etc.
 *   createWordFromText renders these as proper Word footnotes.
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

/**
 * Split a paragraph string on [FNx] markers.
 * Returns array of { text, fnNumber } segments.
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

/**
 * Build a Word document from translated body text and footnotes.
 *
 * @param {string} translatedText   Body text with inline [FNx] markers.
 * @param {string} originalFilename Used for the document title property.
 * @param {Array}  footnotes        [{ number, text }, ...] — may be empty/null.
 * @returns {Buffer} .docx bytes.
 */
async function createWordFromText(translatedText, originalFilename, footnotes) {
  footnotes = footnotes || [];

  // Build a map for quick footnote lookup by number
  const footnoteMap = {};
  for (const fn of footnotes) {
    footnoteMap[parseInt(fn.number)] = fn.text;
  }

  // Build the docx footnotes object for Document constructor
  // Each footnote is a paragraph with just a TextRun — docx v9 adds footnoteRef automatically
  const docxFootnotes = {};
  for (const fn of footnotes) {
    const num = parseInt(fn.number);
    docxFootnotes[num] = {
      children: [
        new Paragraph({
          children: [
            new TextRun({ text: fn.text, size: 18 })
          ]
        })
      ]
    };
  }

  // Split body text into paragraphs
  const paragraphs = translatedText
    .split(/\n/)
    .map(p => p.trim())
    .filter(Boolean);

  // Build docx paragraph objects
  const docParagraphs = [];

  for (const para of paragraphs) {

    if (para.startsWith('### ')) {
      // Heading
      const headingText = para.slice(4).trim();
      docParagraphs.push(
        new Paragraph({
          text: headingText,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 240, after: 120 }
        })
      );
      continue;
    }

    if (para.startsWith('- ')) {
      // Bullet list item
      const bulletText = para.slice(2).trim();
      docParagraphs.push(
        new Paragraph({
          children: [new TextRun({ text: bulletText, size: 24 })],
          bullet: { level: 0 },
          spacing: { after: 100 }
        })
      );
      continue;
    }

    if (/^\d+\.\s/.test(para)) {
      // Numbered list item
      const listText = para.replace(/^\d+\.\s+/, '').trim();
      const listNum = parseInt(para.match(/^(\d+)/)[1]);
      docParagraphs.push(
        new Paragraph({
          children: [new TextRun({ text: `${listNum}. ${listText}`, size: 24 })],
          spacing: { after: 100 }
        })
      );
      continue;
    }

    // Standard paragraph — parse inline footnote markers
    const segments = parseInlineMarkers(para);
    const children = [];

    for (const seg of segments) {
      if (seg.text) {
        children.push(new TextRun({ text: seg.text, size: 24 }));
      }
      if (seg.fnNumber != null && footnoteMap[seg.fnNumber] !== undefined) {
        children.push(new FootnoteReferenceRun({ footnoteId: seg.fnNumber }));
      }
    }

    docParagraphs.push(
      new Paragraph({
        children,
        spacing: { after: 200 }
      })
    );
  }

  // Create the document — footnotes passed at top level, not inside sections
  const doc = new Document({
    title: originalFilename || 'Translation',
    creator: 'TranslationService',
    footnotes: docxFootnotes,
    sections: [
      {
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
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer;
}

module.exports = { createWordFromText };
