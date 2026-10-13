import { describe, expect, it } from "vitest";
import { verifySignature } from "../../../src/webhooks/signature.js";
import { NOW_SECONDS, sign, TEST_SECRET } from "../../helpers/fakepay.js";

const rawBody = Buffer.from('{"fictional":true}');
function verify(header: string | undefined, body = rawBody, secret = TEST_SECRET) {
  return verifySignature({ rawBody: body, header, secret, nowSeconds: NOW_SECONDS });
}

describe("signature", () => {
  it("accepts the exact signed bytes", () => {
    expect(verify(sign(rawBody))).toEqual({ ok: true });
  });
  it("rejects missing signatures", () => {
    expect(verify(undefined)).toEqual({ ok: false, reason: "missing" });
  });
  it.each([
    "",
    "v1=abcd",
    "t=123",
    "t=hello,v1=abcd",
    "t=123,v1=xyz",
    "t=1.5,v1=abcd",
    "t=1,v1=abc",
    "t=1,t=2,v1=abcd",
    "t=1,v1=ABCD",
    "t=9007199254740992,v1=abcd",
  ])("rejects malformed header %s", (header) => {
    expect(verify(header)).toEqual({ ok: false, reason: "malformed" });
  });
  it("rejects a short digest without throwing", () => {
    expect(verify(`t=${String(NOW_SECONDS)},v1=abcd`)).toEqual({ ok: false, reason: "mismatch" });
  });
  it("rejects another secret", () => {
    expect(verify(sign(rawBody), rawBody, "another-fictional-secret")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
  it("rejects a one-byte body change", () => {
    expect(verify(sign(rawBody), Buffer.from('{"fictional":truE}'))).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
  it.each([-300, 300])("accepts boundary %i seconds", (offset) => {
    expect(verify(sign(rawBody, NOW_SECONDS + offset))).toEqual({ ok: true });
  });
  it.each([-301, 301])("expires at %i seconds", (offset) => {
    expect(verify(sign(rawBody, NOW_SECONDS + offset))).toEqual({ ok: false, reason: "expired" });
  });
});
