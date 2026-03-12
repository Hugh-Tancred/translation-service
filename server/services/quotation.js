'use strict';

/**
 * quotation.js
 * Generates a price quote based on document word count.
 *
 * Pricing model:
 *   - €0.09 per 100 words (= €0.0009/word)
 *   - Minimum charge: €3.00
 *   - Prices rounded up to nearest €0.50
 *
 * The complexityScore passed in is the word count extracted
 * by assessDocument() in assessment.js.
 */

const RATE_PER_100_WORDS = 0.25;   // euros
const MINIMUM_CHARGE     = 5.00;   // euros
const ROUND_TO           = 0.50;   // round up to nearest

function generateQuote(wordCount) {
  // Guard against missing or zero word count
  const words = (wordCount && wordCount > 0) ? wordCount : 500;

  const raw = (words / 100) * RATE_PER_100_WORDS;
  const withMinimum = Math.max(raw, MINIMUM_CHARGE);

  // Round up to nearest 0.50
  const amount = Math.ceil(withMinimum / ROUND_TO) * ROUND_TO;
  const capped = amount;

  return {
    amount: capped,
    currency: 'EUR',
    wordCount: words
  };
}

module.exports = { generateQuote };
