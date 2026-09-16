import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { loadBucketConfigOrThrow } from "./config.js";

let client: S3Client | null = null;
let bucketName: string | null = null;

/**
 * Lazily creates the S3 client. Railway Buckets speak the S3 API, so the
 * stock AWS SDK works against them unmodified -- point it at the bucket's
 * endpoint and force path-style addressing.
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
    bucketName = cfg.name;
  }
  return { client, bucketName };
}

export interface UploadResult {
  bucket: string;
  key: string;
  bytes: number;
}

/**
 * Uploads a local file to the bucket under `recordings/<key>` and returns a
 * reference to where it landed. Does not delete the local file -- callers
 * own the temp file lifecycle.
 */
export async function uploadRecording(
  localPath: string,
  key: string,
): Promise<UploadResult> {
  const { client, bucketName } = getClient();
  const { size } = await stat(localPath);

  const objectKey = `recordings/${key}`;
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: createReadStream(localPath),
      ContentLength: size,
      ContentType: "video/webm",
    }),
  );

  return { bucket: bucketName, key: objectKey, bytes: size };
}
