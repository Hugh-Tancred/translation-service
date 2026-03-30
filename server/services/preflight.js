'use strict';

/**
 * preflight.js
 * Makes a document suitability decision based on signals from assessDocument().
 *
 * Decisions:
 *   'proceed' — document appears suitable for translation
 *   'flag'    — document is translatable but contains significant non-text content;
 *               user should be warned before proceeding
 *   'decline' — document is unsuitable; do not process or charge
 *
 * Hard decline triggers (any one is sufficient):
 *   1. PDF with very low text-to-size ratio (image-heavy or scanned form)
 *      AND high short-token ratio (form fields, codes, numbers dominate)
 *   2. PDF with extremely low text-to-size ratio regardless of token ratio
 *      (near-empty text extraction = almost certainly an image/form document)
 *   3. Scanned PDF with very high short-token ratio
 *      (OCR of a form produces mostly short tokens)
 *
 * Soft flag triggers:
 *   1. PDF with text-to-size ratio in the middle band — enough text to translate
 *      but significant non-text content present (images, graphics, design elements)
 *
 * Bias: deliberately defensive. Better to decline a translatable document
 * than to accept one that produces unusable output.
 *
 * Returns:
 *   { decision: 'proceed' | 'flag' | 'decline', reason: string, signals: object }
 */

// Thresholds — adjust based on real-world testing
const THRESHOLDS = {
  // Below this, document is considered near-empty of extractable text
  VERY_LOW_TEXT_RATIO: 0.005,
  // Below this, document is considered image/form heavy — hard decline zone
  LOW_TEXT_RATIO: 0.02,
  // Below this, document has significant non-text content but is still translatable
  // soft flag zone sits between LOW_TEXT_RATIO and MEDIUM_TEXT_RATIO
  MEDIUM_TEXT_RATIO: 0.08,
  // Above this short-token ratio, document is considered form-like
  HIGH_SHORT_TOKEN_RATIO: 0.65,
};

function preflightCheck(assessment, filename) {
  const {
    textToSizeRatio,
    shortTokenRatio,
    pageCount,
    extractionMethod,
    wordCount
  } = assessment;

  const signals = {
    textToSizeRatio,
    shortTokenRatio,
    pageCount,
    extractionMethod,
    wordCount,
    filename: filename || 'unknown'
  };

  // Word documents: only decline if short-token ratio is extremely high
  if (extractionMethod === 'word') {
    if (shortTokenRatio !== null && shortTokenRatio > THRESHOLDS.HIGH_SHORT_TOKEN_RATIO) {
      const reason = 'Document appears to be a structured form. Form documents cannot be reliably translated as the layout carries meaning that cannot be preserved in translation.';
      console.log(`[PREFLIGHT_DECLINE] method=word shortTokenRatio=${shortTokenRatio.toFixed(2)} file=${filename}`);
      return { decision: 'decline', reason, signals };
    }
    console.log(`[PREFLIGHT_PROCEED] method=word shortTokenRatio=${shortTokenRatio !== null ? shortTokenRatio.toFixed(2) : 'null'} file=${filename}`);
    return { decision: 'proceed', reason: null, signals };
  }

  // PDF: near-empty text extraction with form-like token pattern
  if (
    textToSizeRatio !== null &&
    textToSizeRatio < THRESHOLDS.VERY_LOW_TEXT_RATIO &&
    shortTokenRatio !== null &&
    shortTokenRatio > THRESHOLDS.HIGH_SHORT_TOKEN_RATIO
  ) {
    const reason = 'This document contains very little extractable text. It may be a scanned image, a structured form, or a design-heavy document that cannot be reliably translated.';
    console.log(`[PREFLIGHT_DECLINE] method=${extractionMethod} textToSizeRatio=${textToSizeRatio.toFixed(4)} shortTokenRatio=${shortTokenRatio.toFixed(2)} file=${filename}`);
    return { decision: 'decline', reason, signals };
  }

  // PDF: low text ratio AND form-like token pattern
  if (
    textToSizeRatio !== null &&
    textToSizeRatio < THRESHOLDS.LOW_TEXT_RATIO &&
    shortTokenRatio !== null &&
    shortTokenRatio > THRESHOLDS.HIGH_SHORT_TOKEN_RATIO
  ) {
    const reason = 'This document appears to be a structured form or contains primarily non-text content. Form documents cannot be reliably translated as the layout carries meaning that cannot be preserved.';
    console.log(`[PREFLIGHT_DECLINE] method=${extractionMethod} textToSizeRatio=${textToSizeRatio.toFixed(4)} shortTokenRatio=${shortTokenRatio.toFixed(2)} file=${filename}`);
    return { decision: 'decline', reason, signals };
  }

  // PDF: middle band — translatable but significant non-text content present
  if (
    textToSizeRatio !== null &&
    textToSizeRatio < THRESHOLDS.MEDIUM_TEXT_RATIO &&
    extractionMethod === 'native'
  ) {
    const reason = 'This document contains images or non-text elements. These will not appear in the translation — the translated text will be complete, but the visual layout may differ from the original.';
    console.log(`[PREFLIGHT_FLAG] method=${extractionMethod} textToSizeRatio=${textToSizeRatio.toFixed(4)} shortTokenRatio=${shortTokenRatio !== null ? shortTokenRatio.toFixed(2) : 'null'} file=${filename}`);
    return { decision: 'flag', reason, signals };
  }

// Scanned PDF — warn that visual layout will not be preserved
if (extractionMethod === 'scanned') {
  const reason = 'This is a scanned document. The text will be extracted and translated, but images, stamps, signatures, and visual layout will not appear in the translation.';
  console.log(`[PREFLIGHT_FLAG] method=scanned textToSizeRatio=${textToSizeRatio !== null ? textToSizeRatio.toFixed(4) : 'null'} file=${filename}`);
  return { decision: 'flag', reason, signals };
}

  // All checks passed
  console.log(`[PREFLIGHT_PROCEED] method=${extractionMethod} textToSizeRatio=${textToSizeRatio !== null ? textToSizeRatio.toFixed(4) : 'null'} shortTokenRatio=${shortTokenRatio !== null ? shortTokenRatio.toFixed(2) : 'null'} file=${filename}`);
  return { decision: 'proceed', reason: null, signals };
}

module.exports = { preflightCheck };
