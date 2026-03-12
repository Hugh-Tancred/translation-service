const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

async function uploadFile(key, buffer, contentType = 'application/pdf') {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  });

  await s3Client.send(command);
  return key;
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
