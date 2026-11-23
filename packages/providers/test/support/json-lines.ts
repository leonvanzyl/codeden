import { existsSync, readFileSync } from "node:fs";

/**
 * The records of a JSON-lines log that a fake agent process may still be appending to (`[]`
 * while it doesn't exist). A test that polls the log can catch the file just created and still
 * empty, or its last line only partly written, so only lines that end in a newline are read.
 */
export function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as T);
}
