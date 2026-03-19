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

async function assessDocument(buffer, filename) {
  try {
    const ext = (filename || '').split('.').pop().toLowerCase();
    if (ext === 'docx') {
      return assessWord(buffer);
    } else {
      return await assessPdf(buffer);
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

async function assessPdf(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const wordCount = countWords(data.text);
    if (wordCount > 50) {
      console.log(`Assessment (PDF): native, exact word count = ${wordCount}`);
      return { wordCount };
    }
    const result = Math.max(Math.round(buffer.length / 300), 500);
    console.log(`Assessment (PDF): scanned, size-based estimate = ${result}`);
    return { wordCount: result };
  } catch (err) {
    console.warn('PDF assessment failed:', err.message);
    return { wordCount: 500 };
  }
}


module.exports = { assessDocument };
