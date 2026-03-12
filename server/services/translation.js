const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { extractText, createPdfFromText } = require('../utils/pdf');
const { createWordFromText } = require('../utils/word');
const { downloadFile, uploadFile, getPresignedUrl } = require('./storage');
const { extractTextWithOCR } = require('./ocr');
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

// Max characters to send in a single translation call.
// ~12,000 chars ≈ ~4,000 source tokens → leaves plenty of headroom for
// the translated output within a 16,000 token limit.
const TRANSLATION_CHUNK_CHARS = 6000;

function normalizeForPdf(text) {
  return text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, char => SUPERSCRIPT_MAP[char]);
}

function buildSystemPrompt(sourceLanguage) {
  return `You are a professional translator. Translate the following document from ${sourceLanguage} to English.
Maintain the original formatting, paragraph structure, and meaning as closely as possible.
Preserve any technical terms, proper nouns, and specialized vocabulary appropriately.
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

// Split body text into chunks at paragraph boundaries, keeping each chunk
// under TRANSLATION_CHUNK_CHARS characters.
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
    text = text.replace(/##TITLE## /g,    '⟦TITLE⟧ ')
               .replace(/##HEADING## /g,  '⟦HEADING⟧ ')
               .replace(/##LISTITEM## /g, '⟦LISTITEM⟧ ');

    let translatedContent;
    switch (CURRENT_MODEL.provider) {
      case 'anthropic': translatedContent = await translateWithClaude(text, systemPrompt); break;
      case 'openai': translatedContent = await translateWithOpenAI(text, systemPrompt); break;
      case 'google': translatedContent = await translateWithGemini(text, systemPrompt); break;
      default: throw new Error(`Unknown provider: ${CURRENT_MODEL.provider}`);
    }

    // Restore structural tags
    translatedContent = translatedContent.replace(/⟦TITLE⟧ /g,    '##TITLE## ')
                                         .replace(/⟦HEADING⟧ /g,  '##HEADING## ')
                                         .replace(/⟦LISTITEM⟧ /g, '##LISTITEM## ');

    return translatedContent;
  } catch (error) {
    console.error(`${CURRENT_MODEL.name} API error:`, error.message);
    throw error;
  }
}

// Translate body text in paragraph-aware chunks and reassemble.
async function translateBodyText(text, sourceLanguage) {
  const chunks = chunkBodyText(text);

  if (chunks.length === 1) {
    console.log(`Translation: single chunk (${text.length} chars)`);
    return await translateText(text, sourceLanguage);
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
    attempts++;
    if (attempts >= 3) throw err;
    console.log(`Translation: chunk ${i + 1} attempt ${attempts} failed (${err.message}), retrying in ${attempts * 10}s...`);
    await new Promise(r => setTimeout(r, attempts * 10000));
  }
}
    translatedChunks.push(translated);
  }
  console.log(`Translation: all body chunks complete, reassembling...`);
  return translatedChunks.join('\n\n');
}

async function processTranslation(orderId, outputFormat = 'pdf') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('Order not found');

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('processing', orderId);

  try {
    // Route to Word extraction or OCR depending on file type
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

    // Translate body text — chunked to avoid token limit truncation
    const translatedText = await translateBodyText(ocrResult.text, order.source_language);

    // Translate footnotes individually with a dedicated citation prompt
    const footnotePrompt = buildFootnotePrompt(order.source_language);
    const translatedFootnotes = [];
    for (const fn of (ocrResult.footnotes || [])) {
      console.log(`Translating footnote ${fn.number}...`);
      const translatedContent = await translateText(fn.text, order.source_language, footnotePrompt);
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

    // CRITICAL: Uploading with the correct MIME type
    await uploadFile(translatedKey, translatedFile, contentType);

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    db.prepare('UPDATE orders SET s3_key_translated = ?, status = ?, completed_at = CURRENT_TIMESTAMP, expires_at = ? WHERE id = ?')
      .run(translatedKey, 'delivered', expiresAt, orderId);

    return { success: true, translatedKey };
  } catch (error) {
    console.error(`Order ${orderId}: Translation pipeline failed:`, error.message);
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('failed', orderId);
    throw error;
  }
}

module.exports = { translateText, processTranslation, SUPPORTED_LANGUAGES };
