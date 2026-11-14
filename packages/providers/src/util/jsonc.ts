/**
 * Parse JSON that may hold `//` and `/* *\/` comments and trailing commas, as hand-edited
 * settings files do. Anything inside strings is kept as it is. Returns undefined when the text
 * still isn't JSON.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  const commas: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, i + 1);
      i += 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      if (ch === ",") commas.push(out.length);
      out += ch;
      i += 1;
    }
  }
  // Trailing commas (outside strings) before a closing brace or bracket.
  for (const at of commas.reverse()) {
    if (/^\s*[}\]]/.test(out.slice(at + 1))) out = out.slice(0, at) + out.slice(at + 1);
  }
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}
