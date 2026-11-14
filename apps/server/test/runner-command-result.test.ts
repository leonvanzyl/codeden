import { FS_CHUNK_MAX_BYTES, TRANSFER_CHUNK_BYTES } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { commandResult } from "../src/runner/client";

/**
 * Results from a runner are untrusted input (a sandbox runner shares its sandbox with an
 * agent): a file chunk over its cap, which would pass the workspace-file frame size, is refused
 * as `too_large`, and anything else malformed as `invalid_result`.
 */

const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

describe("runner command results", () => {
  it("accepts chunks within their caps", () => {
    const read = commandResult("fs.read", {
      data: b64(FS_CHUNK_MAX_BYTES),
      sizeBytes: 9,
      eof: true,
    });
    expect(Buffer.from(read.data, "base64").length).toBe(FS_CHUNK_MAX_BYTES);
  });

  it("refuses a chunk over its cap as too_large", () => {
    expect(() =>
      commandResult("fs.read", { data: b64(FS_CHUNK_MAX_BYTES + 3), sizeBytes: 9, eof: false }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
    expect(() =>
      commandResult("transfer.read", { data: b64(TRANSFER_CHUNK_BYTES + 3), eof: false }),
    ).toThrow(expect.objectContaining({ code: "too_large" }));
  });

  it("refuses a malformed result as invalid_result", () => {
    expect(() => commandResult("fs.read", { data: "%%", eof: "no" })).toThrow(
      expect.objectContaining({ code: "invalid_result" }),
    );
  });
});
