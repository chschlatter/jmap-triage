// Shared S3 get/put-JSON helper: owns the S3Client and the parse/stringify
// boilerplate, so current-prompt.ts, history.ts and approve.ts stay about
// their own record shapes.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Explicit region, not S3Client({}): the bucket is in eu-central-1 regardless
// of caller. Lambda sets AWS_REGION itself, but on the CLI/eval path the
// SDK's resolution chain (~/.aws/config, ...) errors with
// IllegalLocationConstraintException the moment it resolves elsewhere.
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
