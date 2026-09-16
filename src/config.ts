import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

  // MCP_API_KEY is optional. When set, every /mcp request must include it as
  // a Bearer token. When unset, the server runs unauthenticated (fine for
  // local development, NOT fine for a public deployment).
  mcpApiKey: process.env.MCP_API_KEY,
};

// These five names are exactly what Railway's Bucket "Connect Service to
// Bucket -> AWS SDK (Generic)" button writes onto a service -- so wiring a
// bucket up is "click the button", not "copy five values by hand".
//
// Note: they're read explicitly here (rather than leaning on the AWS SDK's
// own env var auto-resolution) on purpose. The SDK's default region
// resolver only reads AWS_REGION, not AWS_DEFAULT_REGION, so relying on
// implicit resolution would silently fail against Railway's preset. Explicit
// reads also give a clear "which variable is missing" error instead of the
// SDK's generic "could not load credentials" message.
export function loadBucketConfigOrThrow() {
  return {
    endpoint: required("AWS_ENDPOINT_URL"),
    bucketName: required("AWS_S3_BUCKET_NAME"),
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    region: process.env.AWS_DEFAULT_REGION ?? "auto",
  };
}
