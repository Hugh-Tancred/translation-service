'use strict';

/**
 * assessment.js
 * Estimates word count from an uploaded document buffer.
 * Also extracts signals used by preflight.js for document suitability checking.
 * Used at quote time — must be fast and not require OCR.
 *
 * Strategy:
 *   .docx  — extract text directly from word/document.xml (exact)
 *   .pdf   — count readable text bytes as a proxy (approximate)
 *   other  — fall back to 500 words (triggers minimum charge)
 *
 * Returns:
 *   wordCount        — estimated word count
 *   textToSizeRatio  — extracted text bytes / file size (0–1)
 *   shortTokenRatio  — proportion of tokens that are 1–3 chars (form signal)
 *   pageCount        — number of pages (PDF only, else null)
 *   extractionMethod — 'native' | 'scanned' | 'word'
 */

const AdmZip = require('adm-zip');

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function shortTokenRatio(text) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const short = tokens.filter(t => t.length <= 3).length;
  return short / tokens.length;
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
    return {
      wordCount: 500,
      textToSizeRatio: null,
      shortTokenRatio: null,
      pageCount: null,
      extractionMethod: 'fallback'
    };
  }
}

function assessWord(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const xml = zip.readAsText('word/document.xml');
    const matches = xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    const wordCount = countWords(text);
    const str = shortTokenRatio(text);
    console.log(`Assessment (Word): ${wordCount} words, shortTokenRatio=${str.toFixed(2)}`);
    return {
      wordCount: wordCount || 500,
      textToSizeRatio: null,
      shortTokenRatio: str,
      pageCount: null,
      extractionMethod: 'word'
    };
  } catch (err) {
    console.warn('Word assessment failed:', err.message);
    return {
      wordCount: 500,
      textToSizeRatio: null,
      shortTokenRatio: null,
      pageCount: null,
      extractionMethod: 'fallback'
    };
  }
}

async function assessPdf(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    const wordCount = countWords(data.text);
    const tsr = data.text.length / buffer.length;
    const str = shortTokenRatio(data.text);
    const pageCount = data.numpages || null;

    if (wordCount > 50) {
      console.log(`Assessment (PDF): native, words=${wordCount} textToSizeRatio=${tsr.toFixed(3)} shortTokenRatio=${str.toFixed(2)} pages=${pageCount}`);
      return {
        wordCount,
        textToSizeRatio: tsr,
        shortTokenRatio: str,
        pageCount,
        extractionMethod: 'native'
      };
    }

    const estimated = Math.max(Math.round(buffer.length / 300), 500);
    console.log(`Assessment (PDF): scanned, size-based estimate=${estimated} textToSizeRatio=${tsr.toFixed(3)} pages=${pageCount}`);
    return {
      wordCount: estimated,
      textToSizeRatio: tsr,
      shortTokenRatio: str,
      pageCount,
      extractionMethod: 'scanned'
    };
  } catch (err) {
    console.warn('PDF assessment failed:', err.message);
    return {
      wordCount: 500,
      textToSizeRatio: null,
      shortTokenRatio: null,
      pageCount: null,
      extractionMethod: 'fallback'
    };
  }
}

module.exports = { assessDocument };
