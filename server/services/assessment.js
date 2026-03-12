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
    // Extract readable ASCII text from PDF binary as a quick proxy
    const text = buffer.toString('latin1');
    // Pull out text between BT/ET (PDF text blocks) or just readable runs
    const readable = text.replace(/[^\x20-\x7E\s]/g, ' ').replace(/\s+/g, ' ');
    const rawWords = countWords(readable);
    // PDF raw text extraction over-counts due to metadata/binary artifacts
    // Apply a conservative factor of 0.35
    const wordCount = Math.max(Math.round(rawWords * 0.10), 100);
    console.log(`Assessment (PDF): ~${wordCount} words (raw: ${rawWords})`);
    return { wordCount };
  } catch (err) {
    console.warn('PDF assessment failed:', err.message);
    return { wordCount: 500 };
  }
}

module.exports = { assessDocument };
