import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { loadBucketConfigOrThrow } from "./config.js";

// SigV4 presigned URLs cap out at 7 days -- that's how long returned links
// (recordings and screenshots alike) stay valid. Railway Buckets aren't
// publicly readable by default, so a plain "endpoint + bucket + key" URL
// wouldn't be fetchable; a presigned URL is a time-limited, credential-free
// link the MCP client can actually open without needing the bucket's
// access keys.
const PRESIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

let client: S3Client | null = null;
let bucketName: string | null = null;

/**
 * Lazily creates the S3 client. Railway Buckets speak the S3 API, so the
 * stock AWS SDK works against them unmodified -- point it at the bucket's
 * endpoint and force path-style addressing (Railway's endpoint doesn't do
 * virtual-hosted-style bucket subdomains).
 */
function getClient(): { client: S3Client; bucketName: string } {
  if (!client || !bucketName) {
    const cfg = loadBucketConfigOrThrow();
    client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    bucketName = cfg.bucketName;
  }
  return { client, bucketName };
}

export interface UploadResult {
  bucket: string;
  key: string;
  bytes: number;
  /** Presigned GET URL, valid for PRESIGNED_URL_TTL_SECONDS. */
  url: string;
  expiresAt: string;
}

/** Shared upload-then-sign path for both recordings and screenshots. */
async function uploadAndSign(
  objectKey: string,
  body: Buffer | Readable,
  contentType: string,
  bytes: number,
): Promise<UploadResult> {
  const { client, bucketName } = getClient();

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: body,
      ContentLength: bytes,
      ContentType: contentType,
    }),
  );

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucketName, Key: objectKey }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );

  return {
    bucket: bucketName,
    key: objectKey,
    bytes,
    url,
    expiresAt: new Date(Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Uploads a local file to the bucket under `recordings/<key>` and returns a
 * presigned link to it. Does not delete the local file -- callers own the
 * temp file lifecycle.
 */
export async function uploadRecording(
  localPath: string,
  key: string,
): Promise<UploadResult> {
  const { size } = await stat(localPath);
  return uploadAndSign(`recordings/${key}`, createReadStream(localPath), "video/webm", size);
}

/**
 * Uploads an in-memory screenshot to the bucket under `screenshots/<key>`
 * and returns a presigned link to it.
 */
export async function uploadScreenshot(buffer: Buffer, key: string): Promise<UploadResult> {
  return uploadAndSign(`screenshots/${key}`, buffer, "image/jpeg", buffer.length);
}
