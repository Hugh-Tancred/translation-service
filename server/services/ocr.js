const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PDFDocument } = require('pdf-lib');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const CHUNK_SIZE = 12; // pages per OCR chunk
const MAX_TOKENS = 32000;

function buildOcrPrompt(startPage, endPage, totalPages) {
  const pageInfo = totalPages > CHUNK_SIZE
    ? `You are transcribing pages ${startPage} to ${endPage} of a ${totalPages}-page document.`
    : `You are transcribing a document.`;

  return `${pageInfo} Your output will be passed directly to a translation engine, so follow these rules precisely:

1. Output ALL text visible in the document — miss nothing.
2. Preserve paragraph breaks with a blank line between paragraphs.
3. IMPORTANT: Each numbered list item MUST be on its own line. Never put "1. text 2. text" on one line.
4. IMPORTANT: Each bullet list item MUST be on its own line. Never inline them with " - " separators.
5. Preserve bold section headings — prefix them with ##HEADING## on their own line, e.g. ##HEADING## Section Title
6. Mark footnote reference numbers inline in the body text as [FN1] [FN2] etc.
7. At the very end of your output, after a line containing only "---FOOTNOTES---", list each footnote as:
   FOOTNOTE 1: <full text of footnote 1>
   FOOTNOTE 2: <full text of footnote 2>
   etc.
8. If there are no footnotes, do not include the ---FOOTNOTES--- section at all.
9. For multi-column layouts (e.g. letter headers), transcribe left column first, then right column, each on separate lines.
10. For tables: render them using markdown table syntax with pipe characters.
    Use a header row and separator row even if the original has no visible header.
    Example:
    | Column A | Column B | Column C |
    |----------|----------|----------|
    | value 1  | value 2  | value 3  |
    If a table has paired columns in two languages (e.g. German | English side by side),
    output only the left-hand (source language) column — ignore the right-hand column entirely.
    Never linearise table content — never run cell values together as prose or separate lines.
11. Do NOT include page numbers, decorative rules, or image descriptions.
12. Output plain text only — no markdown formatting symbols except ##HEADING## for headings and - for bullets.`;
}

function parseTranscription(rawText) {
  const footnoteMarker = '---FOOTNOTES---';
  const footnoteIndex = rawText.indexOf(footnoteMarker);

  let bodyText = rawText;
  // Fix inline bullets that Claude ran together: "text - item - item" → proper lines
  bodyText = bodyText.replace(/ - ([A-Za-z])/g, '\n- $1');
  // Fix inline numbered items: "1. text 2. text" → separate lines
  bodyText = bodyText.replace(/(\d+\.\s[^\n]+?)\s+(\d+\.\s)/g, '$1\n$2');
  const footnotes = [];

  if (footnoteIndex !== -1) {
    bodyText = rawText.substring(0, footnoteIndex).trim();
    const footnoteSection = rawText.substring(footnoteIndex + footnoteMarker.length).trim();

    const fnLines = footnoteSection.split('\n');
    for (const line of fnLines) {
      const match = line.match(/^FOOTNOTE\s+(\d+):\s*(.+)$/i);
      if (match) {
        footnotes.push({
          page: 1,
          number: parseInt(match[1], 10),
          text: match[2].trim()
        });
      }
    }
  }

  return { bodyText, footnotes };
}

// Normalise a chunk's footnotes to sequential 1-N regardless of what numbers
// Claude assigned. This makes offset arithmetic reliable across chunks.
function normaliseFootnotes(bodyText, footnotes) {
  if (footnotes.length === 0) return { bodyText, footnotes };

  const sorted = [...footnotes].sort((a, b) => a.number - b.number);

  // First pass: replace original [FNx] markers with temp placeholders.
  // Process in reverse numeric order to avoid [FN1] matching inside [FN10] etc.
  const reverseSorted = [...sorted].sort((a, b) => b.number - a.number);
  let normalisedBody = bodyText;
  for (const fn of reverseSorted) {
    normalisedBody = normalisedBody.split(`[FN${fn.number}]`).join(`[FNTEMP${fn.number}]`);
  }

  // Second pass: replace temp placeholders with sequential 1-N
  const normalisedFootnotes = [];
  sorted.forEach((fn, idx) => {
    const seqNum = idx + 1;
    normalisedBody = normalisedBody.split(`[FNTEMP${fn.number}]`).join(`[FN${seqNum}]`);
    normalisedFootnotes.push({ ...fn, number: seqNum });
  });

  return { bodyText: normalisedBody, footnotes: normalisedFootnotes };
}

// Apply a running offset to body markers and footnote numbers.
function applyFootnoteOffset(bodyText, footnotes, offset) {
  if (offset === 0) return { bodyText, footnotes };

  // Process in reverse order to avoid [FN1] matching inside [FN10] etc.
  const reverseSorted = [...footnotes].sort((a, b) => b.number - a.number);
  let adjustedBody = bodyText;
  for (const fn of reverseSorted) {
    adjustedBody = adjustedBody.split(`[FN${fn.number}]`).join(`[FN${fn.number + offset}]`);
  }

  const adjustedFootnotes = footnotes.map(fn => ({
    ...fn,
    number: fn.number + offset
  }));

  return { bodyText: adjustedBody, footnotes: adjustedFootnotes };
}

async function extractChunk(pdfBuffer, startPage, endPage, totalPages) {
  const srcDoc = await PDFDocument.load(pdfBuffer);
  const chunkDoc = await PDFDocument.create();

  const pageIndices = [];
  for (let i = startPage - 1; i < endPage; i++) {
    pageIndices.push(i);
  }

  const copiedPages = await chunkDoc.copyPages(srcDoc, pageIndices);
  for (const page of copiedPages) {
    chunkDoc.addPage(page);
  }

  const chunkBytes = await chunkDoc.save();
  const chunkBase64 = Buffer.from(chunkBytes).toString('base64');

  console.log(`OCR: Sending pages ${startPage}-${endPage} to Claude (${chunkBytes.length} bytes)...`);

  const stream = await anthropic.messages.stream({
    model: 'claude-opus-4-5',
    max_tokens: MAX_TOKENS,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: chunkBase64
          }
        },
        {
          type: 'text',
          text: buildOcrPrompt(startPage, endPage, totalPages)
        }
      ]
    }]
  });

  const response = await stream.finalMessage();
  const rawText = response.content[0].text;
  console.log(`OCR: Pages ${startPage}-${endPage} transcription received (${rawText.length} chars)`);

  return parseTranscription(rawText);
}

async function extractTextWithOCR(s3Key) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  const tmpDir = os.tmpdir();
  const tmpPdfPath = path.join(tmpDir, `ocr_${Date.now()}.pdf`);

  console.log(`OCR: Downloading PDF from S3: ${s3Key}`);

  try {
    const getCommand = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: s3Key
    });
    const s3Response = await s3Client.send(getCommand);

    const chunks = [];
    for await (const chunk of s3Response.Body) {
      chunks.push(chunk);
    }
    const pdfBuffer = Buffer.concat(chunks);
    fs.writeFileSync(tmpPdfPath, pdfBuffer);
    console.log(`OCR: PDF saved to temp file (${pdfBuffer.length} bytes)`);

    // Check page count to decide whether chunking is needed
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = pdfDoc.getPageCount();
    console.log(`OCR: Document has ${totalPages} pages (chunk size: ${CHUNK_SIZE})`);

    let allBodyText = '';
    let allFootnotes = [];
    let footnoteOffset = 0;

    if (totalPages <= CHUNK_SIZE) {
      // Short document — send whole as before
      const pdfBase64 = pdfBuffer.toString('base64');
      console.log(`OCR: Sending full PDF to Claude for transcription...`);

      const stream = await anthropic.messages.stream({
        model: 'claude-opus-4-5',
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64
              }
            },
            {
              type: 'text',
              text: buildOcrPrompt(1, totalPages, totalPages)
            }
          ]
        }]
      });

      const finalMsg = await stream.finalMessage();
      const rawText = finalMsg.content[0].text;
      console.log(`OCR: Transcription received (${rawText.length} chars)`);
      const result = parseTranscription(rawText);
      allBodyText = result.bodyText;
      allFootnotes = result.footnotes;

    } else {
      // Long document — process in chunks
      const numChunks = Math.ceil(totalPages / CHUNK_SIZE);
      console.log(`OCR: Splitting into ${numChunks} chunks of up to ${CHUNK_SIZE} pages`);

      for (let i = 0; i < numChunks; i++) {
        const startPage = i * CHUNK_SIZE + 1;
        const endPage = Math.min((i + 1) * CHUNK_SIZE, totalPages);

        const { bodyText: rawBody, footnotes: rawFootnotes } = await extractChunk(
          pdfBuffer, startPage, endPage, totalPages
        );

        // Step 1: normalise this chunk's footnotes to sequential 1-N
        const { bodyText: normBody, footnotes: normFootnotes } =
          normaliseFootnotes(rawBody, rawFootnotes);

        console.log(`OCR: chunk ${i + 1} — ${normFootnotes.length} footnotes normalised (1-${normFootnotes.length}), applying offset ${footnoteOffset}`);

        // Step 2: apply running offset to get globally unique numbers
        const { bodyText: adjustedBody, footnotes: adjustedFn } =
          applyFootnoteOffset(normBody, normFootnotes, footnoteOffset);

        adjustedFn.forEach(fn => {
          console.log(`OCR: footnote ${fn.number} extracted (chunk ${i + 1})`);
        });

        allBodyText += (allBodyText ? '\n\n' : '') + adjustedBody;
        allFootnotes = allFootnotes.concat(adjustedFn);

        // Advance offset by the exact count of footnotes in this chunk
        footnoteOffset += normFootnotes.length;
      }
    }

    if (!allBodyText || allBodyText.trim().length === 0) {
      throw new Error('OCR completed but no text was extracted. The document may be blank or unreadable.');
    }

    console.log(`OCR complete: ${allFootnotes.length} footnotes extracted across ${totalPages} pages`);

    return {
      text: allBodyText,
      footnotes: allFootnotes,
      hasFootnotes: allFootnotes.length > 0,
      isOCR: true,
      blockCount: allBodyText.length
    };

  } finally {
    if (fs.existsSync(tmpPdfPath)) {
      fs.unlinkSync(tmpPdfPath);
      console.log('OCR: Temp file cleaned up');
    }
  }
}

module.exports = { extractTextWithOCR };
