'use strict';

/**
 * assessment.js
 * Estimates word count from an uploaded document buffer.
 * Used at quote time — must be fast and not require OCR.
 *
 * Strategy:
 *   .docx  — extract text directly from word/document.xml (exact)
 *   .pdf   — count readable text bytes as a proxy (approximate)
 *   other  — fall back to 500 words (triggers minimum charge)
 */

const AdmZip = require('adm-zip');

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function assessDocument(buffer, filename) {
  try {
    const ext = (filename || '').split('.').pop().toLowerCase();

    if (ext === 'docx') {
      return assessWord(buffer);
    } else {
      return assessPdf(buffer);
    }
  } catch (err) {
    console.warn('Assessment failed, using fallback word count:', err.message);
    return { wordCount: 500 };
  }
}

function assessWord(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const xml = zip.readAsText('word/document.xml');
    // Extract text content between <w:t> tags
    const matches = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    const wordCount = countWords(text);
    console.log(`Assessment (Word): ${wordCount} words`);
    return { wordCount: wordCount || 500 };
  } catch (err) {
    console.warn('Word assessment failed:', err.message);
    return { wordCount: 500 };
  }
}

function assessPdf(buffer) {
  try {
    // Attempt proper text extraction from native PDF
    const rawText = extractNativePdfText(buffer);
    const wordCount = countWords(rawText);

    if (wordCount > 50) {
      // Native PDF — text layer found, count is reliable
      console.log(`Assessment (PDF): native, exact word count = ${wordCount}`);
      return { wordCount };
    }

    // Scanned PDF — no text layer, fall back to file-size estimate
    // Deliberately conservative (over-estimates) to avoid under-quoting
    const sizeBasedCount = Math.round(buffer.length / 300);
    const result = Math.max(sizeBasedCount, 500);
    console.log(`Assessment (PDF): scanned, size-based estimate = ${result}`);
    return { wordCount: result };

  } catch (err) {
    console.warn('PDF assessment failed:', err.message);
    return { wordCount: 500 };
  }
}

function extractNativePdfText(buffer) {
  try {
    // Extract readable text runs from PDF content streams
    // PDF text is contained in BT...ET blocks, within Tj, TJ, ' and " operators
    const content = buffer.toString('latin1');

    const textRuns = [];

    // Match BT...ET text blocks
    const btEtRegex = /BT[\s\S]*?ET/g;
    let block;
    while ((block = btEtRegex.exec(content)) !== null) {
      const blockText = block[0];

      // Extract strings from parentheses: (text) Tj or (text) '
      const parenRegex = /\(([^)]*)\)\s*(?:Tj|'|")/g;
      let match;
      while ((match = parenRegex.exec(blockText)) !== null) {
        const decoded = decodePdfString(match[1]);
        if (decoded.trim()) textRuns.push(decoded);
      }

      // Extract strings from TJ arrays: [(text) ...] TJ
      const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g;
      while ((match = tjArrayRegex.exec(blockText)) !== null) {
        const arrayContent = match[1];
        const innerStrings = arrayContent.match(/\(([^)]*)\)/g) || [];
        for (const s of innerStrings) {
          const decoded = decodePdfString(s.slice(1, -1));
          if (decoded.trim()) textRuns.push(decoded);
        }
      }
    }

    return textRuns.join(' ');
  } catch (err) {
    console.warn('Native PDF text extraction failed:', err.message);
    return '';
  }
}

function decodePdfString(str) {
  // Handle basic PDF string escape sequences
  return str
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/[^\x20-\x7E]/g, ' ') // strip non-ASCII
    .trim();
}

module.exports = { assessDocument };
