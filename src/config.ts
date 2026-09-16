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

  bucket: {
    endpoint: process.env.BUCKET_ENDPOINT,
    name: process.env.BUCKET_NAME,
    accessKeyId: process.env.BUCKET_ACCESS_KEY,
    secretAccessKey: process.env.BUCKET_SECRET_KEY,
    region: process.env.BUCKET_REGION ?? "auto",
  },
};

export function loadBucketConfigOrThrow() {
  return {
    endpoint: required("BUCKET_ENDPOINT"),
    name: required("BUCKET_NAME"),
    accessKeyId: required("BUCKET_ACCESS_KEY"),
    secretAccessKey: required("BUCKET_SECRET_KEY"),
    region: process.env.BUCKET_REGION ?? "auto",
  };
}
