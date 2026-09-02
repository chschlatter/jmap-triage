// Tiny shared S3 get/put-JSON helper. Every jmap-triage-mcp module that
// touches S3 (current-prompt.ts, history.ts, approve.ts) reads or writes a
// plain JSON object at one key -- this is the one place that owns the
// S3Client and the JSON.parse/stringify boilerplate, so those modules stay
// about their own record shape, not about S3.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Explicit region, not S3Client({}) -- PromptStoreBucket lives in
// eu-central-1 regardless of caller (same region every other AWS call in
// this repo targets). Inside Lambda this doesn't matter (AWS_REGION is set
// automatically), but a bare S3Client({}) falls back to the SDK's default
// region resolution chain (~/.aws/config, AWS_REGION, etc.) for the CLI/
// eval path, which errors with IllegalLocationConstraintException the
// moment that resolves to anything other than eu-central-1.
const S3_REGION = "eu-central-1";
const s3 = new S3Client({ region: S3_REGION });

export async function getJson<T>(bucket: string, key: string): Promise<T> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const text = await res.Body?.transformToString();
  if (text === undefined) {
    throw new Error(`Empty response body reading s3://${bucket}/${key}`);
  }
  return JSON.parse(text) as T;
}

export async function putJson(bucket: string, key: string, value: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: "application/json",
    })
  );
}
