import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, base64ByteLength, validateWorkItemImages } from "../shared/limits";

describe("base64ByteLength", () => {
  it("returns the decoded byte length, accounting for padding", () => {
    // "hi" → "aGk=" (2 bytes), "hi!" → "aGkh" (3 bytes).
    expect(base64ByteLength("aGk=")).toBe(2);
    expect(base64ByteLength("aGkh")).toBe(3);
    expect(base64ByteLength("")).toBe(0);
  });
});

describe("validateWorkItemImages", () => {
  const ok = { mimeType: "image/png", byteLength: 1024 };

  it("accepts an empty or undefined set", () => {
    expect(validateWorkItemImages(undefined)).toBeNull();
    expect(validateWorkItemImages([])).toBeNull();
  });

  it("accepts a set within the count and size limits", () => {
    expect(validateWorkItemImages([ok, ok])).toBeNull();
  });

  it("rejects too many images", () => {
    const many = Array.from({ length: IMAGE_MAX_COUNT + 1 }, () => ok);
    expect(validateWorkItemImages(many)).toEqual({ field: "images", reason: "too_many" });
  });

  it("rejects an unsupported type", () => {
    expect(validateWorkItemImages([{ mimeType: "image/tiff", byteLength: 1 }])).toEqual({
      field: "images",
      reason: "unsupported_type",
    });
  });

  it("rejects an image over the byte limit", () => {
    expect(validateWorkItemImages([{ mimeType: "image/png", byteLength: IMAGE_MAX_BYTES + 1 }])).toEqual({
      field: "images",
      reason: "too_large",
    });
  });

  it("rejects an image with no bytes", () => {
    expect(validateWorkItemImages([{ mimeType: "image/png", byteLength: 0 }])).toEqual({
      field: "images",
      reason: "empty_data",
    });
  });
});
