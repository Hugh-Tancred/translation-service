# Trans-editor

AI-powered document translation service. Clients upload a PDF or Word document; the service performs OCR if required, translates to UK English, and delivers the output as a PDF or Word (.docx) file.

## Service overview

- Input: PDF (native or scanned) and Word (.docx)
- Output: PDF or Word (.docx), client's choice
- Source languages: major European languages
- Target language: UK English only
- Pricing: €0.25 per 100 words, €5.00 minimum
- Payment: card only, euros only, pay-per-job, no accounts, no subscriptions

## Stack

- **Runtime**: Node.js / Express
- **AI**: Claude API (Opus) for OCR and translation
- **Storage**: AWS S3
- **Email**: SendGrid
- **Payments**: Stripe (manual capture — charge only on successful delivery)
- **Database**: SQLite
- **Hosting**: Railway (continuous deployment from GitHub)
- **Domain**: transeditor.tech

## Local development

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in all values
3. Run `npm install`
4. Run `node server/index.js`
5. Service available at `http://localhost:3000`

## Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `STRIPE_SECRET_KEY` | Stripe secret key (use `sk_test_` for development) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `AWS_ACCESS_KEY_ID` | AWS credentials for S3 |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for S3 |
| `AWS_REGION` | S3 region |
| `S3_BUCKET_NAME` | S3 bucket name |
| `SENDGRID_API_KEY` | SendGrid API key |
| `BASE_URL` | Public URL of the service (e.g. `https://transeditor.tech`) |

## Key files

| File | Role |
|---|---|
| `server/services/translation.js` | Main translation pipeline |
| `server/services/ocr.js` | OCR via Claude API |
| `server/utils/wordExtract.js` | Native Word extraction and structural tagging |
| `server/utils/word.js` | Word output rendering |
| `server/utils/pdf.js` | PDF output rendering |
| `server/routes/webhook.js` | Stripe webhook handler (async background processing) |
| `server/services/stripe.js` | Stripe checkout and payment capture/cancel |

## Development conventions

- **SRT**: save, redeploy, test
- **DSRT**: drop, save, redeploy, test
- All development in Cursor. Do not mix AI assistants on this codebase.
- Commit to GitHub at every stable point — this is the rollback mechanism.
- Prefer complete file rewrites over incremental patching when syntax errors accumulate.

## Deployment

Railway deploys automatically on every push to `main`. Environment variables are managed via the Railway dashboard. The SQLite database persists on a Railway volume.

## Contact

info@transeditor.tech
```
