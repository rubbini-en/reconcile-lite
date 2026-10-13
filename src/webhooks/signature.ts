import { createHmac, timingSafeEqual } from "node:crypto";

/** Provider contract: deliveries older or newer than this are rejected (inclusive). */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Builds a FakePay-Signature header for one delivery attempt (used by the simulator). */
export function signatureHeader(rawBody: Buffer, secret: string, timestampSeconds: number): string {
  const timestamp = String(timestampSeconds);
  const digest = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

type SignatureResult =
  { ok: true } | { ok: false; reason: "missing" | "malformed" | "mismatch" | "expired" };

export function verifySignature({
  rawBody,
  header,
  secret,
  nowSeconds,
}: {
  rawBody: Buffer;
  header: string | undefined;
  secret: string;
  nowSeconds: number;
}): SignatureResult {
  if (header === undefined) return { ok: false, reason: "missing" };
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  const timestamp = match?.[1];
  const hex = match?.[2];
  if (
    timestamp === undefined ||
    hex === undefined ||
    hex.length % 2 !== 0 ||
    !Number.isSafeInteger(Number(timestamp))
  ) {
    return { ok: false, reason: "malformed" };
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest();
  const supplied = Buffer.from(hex, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { ok: false, reason: "mismatch" };
  }
  if (
    !Number.isFinite(nowSeconds) ||
    Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS
  ) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}
