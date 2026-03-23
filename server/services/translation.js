const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { extractText, createPdfFromText } = require('../utils/pdf');
const { createWordFromText } = require('../utils/word');
const { downloadFile, uploadFile, getPresignedUrl } = require('./storage');
const { extractTextWithOCR } = require('./ocr');
const { capturePayment, cancelPayment } = require('./stripe');
const db = require('../config/database');
const { CURRENT_MODEL } = require('../../config');

// Initialize AI clients
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const googleAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const SUPPORTED_LANGUAGES = [
  'German', 'French', 'Spanish', 'Italian', 'Portuguese',
  'Dutch', 'Polish', 'Swedish', 'Danish', 'Norwegian',
  'Finnish', 'Czech', 'Romanian', 'Hungarian', 'Greek'
];

const SUPERSCRIPT_MAP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9'
};

const TRANSLATION_CHUNK_CHARS = 6000;

// If this proportion of chunks are untranslatable, treat as pipeline failure
const SKIP_THRESHOLD = 0.30;

function normalizeForPdf(text) {
  return text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, char => SUPERSCRIPT_MAP[char]);
}

function checkSkipThreshold(translatedText, totalChunks) {
  if (totalChunks <= 1) return false; // Single-chunk docs: don't apply threshold
  const skipCount = (translatedText.match(/\[Translation unavailable for this section\]/g) || []).length;
  const skipRate = skipCount / totalChunks;
  if (skipRate > SKIP_THRESHOLD) {
    console.warn(`Translation: skip threshold exceeded — ${skipCount}/${totalChunks} chunks unavailable (${Math.round(skipRate * 100)}%)`);
    return true;
  }
  return false;
}

function buildSystemPrompt(sourceLanguage) {
  return `You are a professional translator. Translate the following document from ${sourceLanguage} to English.
Maintain the original formatting, paragraph structure, and meaning as closely as possible.
Preserve any technical terms, proper nouns, and specialized vocabulary appropriately.
Any token matching the pattern XX...X (such as XXTITLEX, XXHEADINGX, XXLISTITEMX) is a structural marker — copy it into the output exactly as-is, without modification, translation, or reformatting.
Only output the translation, nothing else.`;
}

function buildFootnotePrompt(sourceLanguage) {
  return `You are a professional legal translator. Translate the following footnote citation from ${sourceLanguage} to English.
This is a short legal citation or reference — translate it directly and completely.
Do not comment on it, explain it, query it, or add any notes whatsoever.
Apply these fixed translations consistently:
- "Pièce" → "Exhibit"
- "Actes d'assignation" → "Writs of summons"
- "Me" or "Maître" → keep as "Me"
- "p." → "p." (keep as is)
Output only the translated citation text, nothing else.`;
}

function chunkBodyText(text) {
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length > TRANSLATION_CHUNK_CHARS && current) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function translateWithClaude(text, systemPrompt) {
  const stream = await anthropic.messages.stream({
    model: CURRENT_MODEL.model,
    max_tokens: CURRENT_MODEL.maxTokens,
    temperature: CURRENT_MODEL.temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: text }]
  });

  let fullText = '';
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      fullText += chunk.delta.text;
    }
  }

  const finalMessage = await stream.finalMessage();
  const usage = finalMessage.usage;
  if (usage) {
    const inputCost  = (usage.input_tokens  / 1_000_000) * 15;
    const outputCost = (usage.output_tokens / 1_000_000) * 75;
    console.log(`Tokens: in=${usage.input_tokens} out=${usage.output_tokens} cost=$${(inputCost + outputCost).toFixed(4)}`);
  }

  return fullText;
}

async function translateWithOpenAI(text, systemPrompt) {
  const isO1Model = CURRENT_MODEL.model.startsWith('o1');
  const messages = isO1Model
    ? [{ role: 'user', content: `${systemPrompt}\n\nDocument:\n\n${text}` }]
    : [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }];

  const requestParams = { model: CURRENT_MODEL.model, messages: messages };
  if (isO1Model) { requestParams.max_completion_tokens = CURRENT_MODEL.maxTokens; }
  else { requestParams.max_tokens = CURRENT_MODEL.maxTokens; requestParams.temperature = CURRENT_MODEL.temperature; }

  const response = await openai.chat.completions.create(requestParams);
  return response.choices[0].message.content;
}

async function translateWithGemini(text, systemPrompt) {
  const model = googleAI.getGenerativeModel({
    model: CURRENT_MODEL.model,
    generationConfig: { temperature: CURRENT_MODEL.temperature, maxOutputTokens: CURRENT_MODEL.maxTokens }
  });
  const result = await model.generateContent(`${systemPrompt}\n\nDocument:\n\n${text}`);
  return result.response.text();
}

async function translateText(text, sourceLanguage = 'European language', customPrompt = null) {
  try {
    const systemPrompt = customPrompt || buildSystemPrompt(sourceLanguage);

    // Protect structural tags from translation model
    text = text.replace(/##TITLE## /g,    'XXTITLEX ')
               .replace(/##HEADING## /g,  'XXHEADINGX ')
               .replace(/##LISTITEM## /g, 'XXLISTITEMX ');

    let translatedContent;
    switch (CURRENT_MODEL.provider) {
      case 'anthropic': translatedContent = await translateWithClaude(text, systemPrompt); break;
      case 'openai': translatedContent = await translateWithOpenAI(text, systemPrompt); break;
      case 'google': translatedContent = await translateWithGemini(text, systemPrompt); break;
      default: throw new Error(`Unknown provider: ${CURRENT_MODEL.provider}`);
    }

    // Restore structural tags
    translatedContent = translatedContent.replace(/XXTITLEX\s*/g,    '##TITLE## ')
                                         .replace(/XXHEADINGX\s*/g,  '##HEADING## ')
                                         .replace(/XXLISTITEMX\s*/g, '##LISTITEM## ');

    return translatedContent;
  } catch (error) {
    console.error(`${CURRENT_MODEL.name} API error:`, error.message);
    throw error;
  }
}

async function translateBodyText(text, sourceLanguage) {
  const chunks = chunkBodyText(text);

  if (chunks.length === 1) {
    console.log(`Translation: single chunk (${text.length} chars)`);
    return { translatedText: await translateText(text, sourceLanguage), totalChunks: 1 };
  }

  console.log(`Translation: splitting body into ${chunks.length} chunks`);
  const translatedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Translation: translating body chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
    let translated;
    let attempts = 0;
    while (attempts < 3) {
      try {
        translated = await translateText(chunks[i], sourceLanguage);
        break;
      } catch (err) {
        const isContentFilter = err.message && (
          err.message.toLowerCase().includes('content') ||
          err.message.toLowerCase().includes('safety') ||
          err.message.toLowerCase().includes('policy')
        );
        if (isContentFilter) {
          console.warn(`Translation: chunk ${i + 1} skipped — content filter (${err.message})`);
          translated = '[Translation unavailable for this section]';
          break;
        }
        attempts++;
        if (attempts >= 3) throw err;
        console.log(`Translation: chunk ${i + 1} attempt ${attempts} failed (${err.message}), retrying in ${attempts * 10}s...`);
        await new Promise(r => setTimeout(r, attempts * 10000));
      }
    }
    translatedChunks.push(translated);
  }
  console.log(`Translation: all body chunks complete, reassembling...`);
  return { translatedText: translatedChunks.join('\n\n'), totalChunks: chunks.length };
}

async function processTranslation(orderId, outputFormat = 'pdf') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('processing', orderId);

  try {
    const isWord = order.original_filename.toLowerCase().endsWith('.docx');
    let ocrResult;
    if (isWord) {
      console.log(`Translation: Word input detected, extracting text directly`);
      const { extractTextFromWord } = require('../utils/wordExtract');
      const fileBuffer = await downloadFile(order.s3_key_original);
      ocrResult = await extractTextFromWord(fileBuffer);
      console.log(`Translation: Word extraction delivered ${ocrResult.text.length} chars, ${ocrResult.footnotes.length} footnotes`);
    } else {
      ocrResult = await extractTextWithOCR(order.s3_key_original);
      console.log(`Translation: OCR delivered ${ocrResult.text.length} chars, ${ocrResult.footnotes.length} footnotes`);
    }

    const { translatedText, totalChunks } = await translateBodyText(ocrResult.text, order.source_language);

    // Check if too many chunks were skipped — treat as pipeline failure
    if (checkSkipThreshold(translatedText, totalChunks)) {
      throw new Error('Translation quality threshold not met — too many sections unavailable');
    }

    const footnotePrompt = buildFootnotePrompt(order.source_language);
    const translatedFootnotes = [];
    for (const fn of (ocrResult.footnotes || [])) {
      console.log(`Translating footnote ${fn.number}...`);
      let translatedContent;
      try {
        translatedContent = await translateText(fn.text, order.source_language, footnotePrompt);
      } catch (err) {
        const isContentFilter = err.message && (
          err.message.toLowerCase().includes('content') ||
          err.message.toLowerCase().includes('safety') ||
          err.message.toLowerCase().includes('policy')
        );
        if (isContentFilter) {
          console.warn(`Translation: footnote ${fn.number} skipped — content filter (${err.message})`);
          translatedContent = '[Translation unavailable]';
        } else {
          throw err;
        }
      }
      translatedFootnotes.push({ number: fn.number, text: translatedContent });
    }
    console.log(`Translation complete: ${translatedFootnotes.length} footnotes translated`);

    const normalizedText = normalizeForPdf(translatedText);
    let translatedFile;
    let fileExtension;
    let contentType;

    if (outputFormat === 'word') {
      translatedFile = await createWordFromText(normalizedText, order.original_filename, translatedFootnotes);
      fileExtension = '_EN.docx';
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else {
      translatedFile = await createPdfFromText(normalizedText, order.original_filename, translatedFootnotes);
      fileExtension = '_EN.pdf';
      contentType = 'application/pdf';
    }

    const translatedKey = `translated/${orderId}/${order.original_filename.replace('.pdf', fileExtension)}`;

    await uploadFile(translatedKey, translatedFile, contentType);

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    db.prepare('UPDATE orders SET s3_key_translated = ?, status = ?, completed_at = CURRENT_TIMESTAMP, expires_at = ? WHERE id = ?')
      .run(translatedKey, 'delivered', expiresAt, orderId);

    // Capture payment now that translation succeeded
    if (order.payment_intent_id) {
      await capturePayment(order.payment_intent_id);
    }

    return { success: true, translatedKey };

  } catch (error) {
    console.error(`Order ${orderId}: Translation pipeline failed:`, error.message);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('failed', orderId);
    // Cancel the authorised payment — customer should not be charged
    if (order.payment_intent_id) {
      await cancelPayment(order.payment_intent_id);
    }
    throw error;
  }
}

module.exports = { translateText, processTranslation, SUPPORTED_LANGUAGES };
