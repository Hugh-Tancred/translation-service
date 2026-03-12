'use strict';

/**
 * wordExtract.js
 * Extracts body text and native Word footnotes from a .docx buffer.
 * Returns the same { text, footnotes } shape as the OCR pipeline.
 */

const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function getText(node) {
  const result = [];
  const tNodes = node.getElementsByTagNameNS(W, 't');
  for (let i = 0; i < tNodes.length; i++) {
    if (tNodes[i].textContent) result.push(tNodes[i].textContent);
  }
  return result.join('');
}

function getStyleId(para) {
  const pPr = para.getElementsByTagNameNS(W, 'pPr')[0];
  if (!pPr) return '';
  const pStyle = pPr.getElementsByTagNameNS(W, 'pStyle')[0];
  if (!pStyle) return '';
  return pStyle.getAttributeNS(W, 'val') || '';
}

async function extractTextFromWord(buffer) {
  const zip = new AdmZip(buffer);
  const parser = new DOMParser();

  const docXml = zip.readAsText('word/document.xml');
  const docDom = parser.parseFromString(docXml, 'text/xml');
  const paragraphs = docDom.getElementsByTagNameNS(W, 'p');

  const bodyLines = [];
  const fnRefPositions = {};

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];

    // Record footnote reference positions
    const fnRefs = para.getElementsByTagNameNS(W, 'footnoteReference');
    for (let j = 0; j < fnRefs.length; j++) {
      const id = fnRefs[j].getAttributeNS(W, 'id');
      if (id && parseInt(id) > 0) {
        fnRefPositions[id] = bodyLines.length;
      }
    }

    const text = getText(para).trim();
    if (!text) continue;

    const styleId = getStyleId(para);

    // Title (Heading 1 — English or German style name)
    if (styleId === 'Heading1' || styleId === 'berschrift1') {
      bodyLines.push('##TITLE## ' + text);

    // Subheading (Heading 2 — English or German style name)
    } else if (styleId === 'Heading2' || styleId === 'berschrift2') {
      bodyLines.push('##HEADING## ' + text);

    // Reference list item (English or German style name)
    } else if (styleId === 'ListParagraph' || styleId === 'Listenabsatz') {
      bodyLines.push('##LISTITEM## ' + text);

    } else {
      bodyLines.push(text);
    }
  }

  // Insert [FN##] markers at correct paragraph positions
  const markerOffsets = {};
  for (const [id, lineIdx] of Object.entries(fnRefPositions)) {
    if (!markerOffsets[lineIdx]) markerOffsets[lineIdx] = [];
    markerOffsets[lineIdx].push(id);
  }

  const bodyWithMarkers = bodyLines.map(function(line, idx) {
    if (markerOffsets[idx]) {
      return line + markerOffsets[idx].map(function(id) { return '[FN' + id + ']'; }).join('');
    }
    return line;
  });

  // Auto-number list items (preserving any existing prefix tags)
  let refCounter = 0;
  const numberedLines = bodyWithMarkers.map(function(line) {
    if (line.startsWith('##LISTITEM## ')) {
      refCounter++;
      return '##LISTITEM## ' + refCounter + '. ' + line.slice(13);
    }
    return line;
  });

  const bodyText = numberedLines.join('\n\n');

  // Extract native Word footnotes
  const footnotes = [];
  const fnEntry = zip.getEntry('word/footnotes.xml');
  if (fnEntry) {
    const fnXml = zip.readAsText('word/footnotes.xml');
    const fnDom = parser.parseFromString(fnXml, 'text/xml');
    const fnNodes = fnDom.getElementsByTagNameNS(W, 'footnote');
    for (let i = 0; i < fnNodes.length; i++) {
      const fn = fnNodes[i];
      const id = fn.getAttributeNS(W, 'id');
      if (!id || parseInt(id) <= 0) continue;
      const text = getText(fn).trim();
      if (text) footnotes.push({ number: id, text });
    }
  }

  console.log('WordExtract: ' + bodyLines.length + ' paragraphs, ' + footnotes.length + ' footnotes extracted');
  return { text: bodyText, footnotes };
}

module.exports = { extractTextFromWord };
