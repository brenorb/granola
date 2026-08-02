import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalJson({ z: [2, { b: true, a: "x" }], a: 1 }))
      .toBe('{"a":1,"z":[2,{"a":"x","b":true}]}');
  });

  it("rejects values JSON cannot represent canonically", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});
