// Tiny shared S3 get/put-JSON helper. Every jmap-triage-mcp module that
// touches S3 (current-prompt.ts, history.ts, approve.ts) reads or writes a
// plain JSON object at one key -- this is the one place that owns the
// S3Client and the JSON.parse/stringify boilerplate, so those modules stay
// about their own record shape, not about S3.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3 = new S3Client({});

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
