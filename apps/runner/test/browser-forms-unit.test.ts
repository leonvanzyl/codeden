import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkUploadPaths,
  chosenOptions,
  pickOptions,
  type SelectInfo,
  select,
} from "../src/browser/forms";
import type { BrowserSession } from "../src/browser/session";
import { CommandError } from "../src/errors";

const country: SelectInfo = {
  tag: "select",
  multiple: false,
  disabled: false,
  options: [
    { index: 0, value: "", label: "Pick one", disabled: false },
    { index: 1, value: "za", label: "South Africa", disabled: false },
    { index: 2, value: "nl", label: "Netherlands", disabled: false },
    { index: 3, value: "xx", label: "Atlantis", disabled: true },
  ],
};

/** The `CommandError` code and message `run` throws. */
function failure(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a CommandError");
}

describe("pickOptions", () => {
  it("picks an option by the label the snapshot shows, or by its value", () => {
    expect(pickOptions("e3", country, ["Netherlands"])).toEqual([2]);
    expect(pickOptions("e3", country, ["za"])).toEqual([1]);
    expect(pickOptions("e3", country, [""])).toEqual([0]);
  });

  it("prefers a label over another option's value", () => {
    const quantity: SelectInfo = {
      ...country,
      options: [
        { index: 0, value: "2", label: "1", disabled: false },
        { index: 1, value: "1", label: "2", disabled: false },
      ],
    };
    expect(pickOptions("e3", quantity, ["1"])).toEqual([0]);
  });

  it("picks several options of a multiple select, each once", () => {
    const multiple = { ...country, multiple: true };
    expect(pickOptions("e3", multiple, ["Netherlands", "za", "nl"])).toEqual([2, 1]);
  });

  it("refuses what a person couldn't choose, saying what to do instead", () => {
    expect(failure(() => pickOptions("e5", { ...country, tag: "div" }, ["x"]))).toMatchObject({
      code: "not_a_select",
      message: expect.stringMatching(/e5 is a <div>, not a <select> menu.*browser_click/),
    });
    expect(failure(() => pickOptions("e3", country, ["za", "nl"]))).toMatchObject({
      code: "not_multiple",
    });
    expect(failure(() => pickOptions("e3", { ...country, disabled: true }, ["za"]))).toMatchObject({
      code: "disabled",
    });
    expect(failure(() => pickOptions("e3", country, ["Atlantis"]))).toMatchObject({
      code: "disabled",
      message: 'Option "Atlantis" (value "xx") of e3 is disabled',
    });
  });

  it("lists the options when a value names none of them", () => {
    const { code, message } = failure(() => pickOptions("e3", country, ["Netherlans"]));
    expect(code).toBe("no_such_option");
    expect(message).toBe(
      'No option of e3 has the label or value "Netherlans". Its options: "Pick one" (value ""), "South Africa" (value "za"), "Netherlands" (value "nl"), "Atlantis" (value "xx").',
    );
    const long: SelectInfo = {
      ...country,
      options: Array.from({ length: 35 }, (_, index) => ({
        index,
        value: String(index),
        label: String(index),
        disabled: false,
      })),
    };
    expect(failure(() => pickOptions("e3", long, ["99"])).message).toMatch(/"29" and 5 more\.$/);
    const empty = { ...country, options: [] };
    expect(failure(() => pickOptions("e3", empty, ["a"])).message).toMatch(/It has no options\.$/);
  });
});

describe("an option's ref", () => {
  it("points to the menu's own ref", () => {
    expect(failure(() => pickOptions("e6", { ...country, tag: "option" }, ["x"]))).toMatchObject({
      code: "not_a_select",
      message: expect.stringMatching(
        /e6 is an <option> of a <select> menu\. Pass the ref of the menu itself/,
      ),
    });
  });
});

describe("chosenOptions", () => {
  it("is exactly the picked options, in menu order", () => {
    expect(chosenOptions(country, [2, 1])).toEqual([
      { value: "za", label: "South Africa" },
      { value: "nl", label: "Netherlands" },
    ]);
    expect(chosenOptions(country, [])).toEqual([]);
  });
});

/**
 * A page holding one `<select>`: `selectOption` records the choice and then, as its change
 * handler may, navigates (the ref resolves to nothing) or leaves the select in place.
 */
function fakeSession(after: "navigates" | "stays" | "reads-fail") {
  let chose: unknown;
  let changed = false;
  const reads: string[] = [];
  const locator = {
    count: async () => (changed && after === "navigates" ? 0 : 1),
    evaluate: async (fn: { name?: string }, _arg?: unknown, opts?: { timeout?: number }) => {
      reads.push(fn.name ?? "");
      if (!changed) return country;
      if (after === "reads-fail") throw new Error(`Timeout ${opts?.timeout}ms exceeded`);
      // The change handler picked another option itself.
      return [{ value: "", label: "Pick one" }];
    },
    selectOption: async (options: unknown) => {
      chose = options;
      changed = true;
      return [];
    },
  };
  const session = {
    tabId: () => "t1",
    page: () => ({ getByRef: () => locator }),
    dialogs: {
      assertNone: () => undefined,
      race: async (_tabId: string, action: () => Promise<unknown>) => {
        await action();
        return {};
      },
    },
  } as unknown as BrowserSession;
  return { session, reads, chose: () => chose };
}

describe("select", () => {
  it("returns the choice at once when the change navigated the page", async () => {
    const page = fakeSession("navigates");
    await expect(select(page.session, "e3", ["Netherlands"])).resolves.toEqual({
      selected: [{ value: "nl", label: "Netherlands" }],
      detached: true,
    });
    expect(page.chose()).toEqual([{ index: 2 }]);
    // Only the read before the choice: nothing waits on the element that went away.
    expect(page.reads).toEqual(["readSelect"]);
  });

  it("returns the choice when the select goes away while it is read back", async () => {
    const page = fakeSession("reads-fail");
    await expect(select(page.session, "e3", ["za"])).resolves.toEqual({
      selected: [{ value: "za", label: "South Africa" }],
      detached: true,
    });
  });

  it("reads the selection back when the select stays", async () => {
    const page = fakeSession("stays");
    await expect(select(page.session, "e3", ["za"])).resolves.toEqual({
      selected: [{ value: "", label: "Pick one" }],
    });
    expect(page.reads).toEqual(["readSelect", "readSelected"]);
  });
});

describe("checkUploadPaths", () => {
  const dir = mkdtempSync(join(tmpdir(), "codeden-upload-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("takes absolute paths of existing files only", () => {
    const csv = join(dir, "data.csv");
    writeFileSync(csv, "a,b\n");
    expect(() => checkUploadPaths([csv])).not.toThrow();
    expect(failure(() => checkUploadPaths(["data.csv"])).code).toBe("invalid_path");
    expect(failure(() => checkUploadPaths([csv, join(dir, "gone.csv")])).code).toBe(
      "file_not_found",
    );
    expect(failure(() => checkUploadPaths([dir])).code).toBe("file_not_found");
  });
});
