const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
console.log('[S3_INIT] region=' + process.env.AWS_REGION + ' keyId=' + (process.env.AWS_ACCESS_KEY_ID || 'MISSING').substring(0, 8) + '...');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.AWS_ENDPOINT_URL,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function uploadFile(key, buffer, contentType = 'application/pdf') {
  console.log('[S3_UPLOAD_ATTEMPT] key=' + key + ' endpoint=' + process.env.AWS_ENDPOINT_URL);
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  try {
    await s3Client.send(command);
    return key;
  } catch (err) {
    console.error('[S3_UPLOAD_ERROR] name=' + err.name + ' message=' + err.message + ' code=' + err.$metadata?.httpStatusCode);
    throw err;
  }
}

async function downloadFile(key) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key
  });

  const response = await s3Client.send(command);
  const chunks = [];

  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function getPresignedUrl(key, expiresIn = 48 * 60 * 60, downloadName = 'document.pdf') {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    // Tells the browser to download the file rather than attempt to open it in a tab
    ResponseContentDisposition: `attachment; filename="${downloadName}"`
  });

  return getSignedUrl(s3Client, command, { expiresIn });
}

async function deleteFile(key) {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key
  });

  await s3Client.send(command);
}

module.exports = {
  uploadFile,
  downloadFile,
  getPresignedUrl,
  deleteFile
};
