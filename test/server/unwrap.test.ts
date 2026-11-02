import { describe, expect, test } from "bun:test";
import { unwrapAgentText } from "../../src/server/unwrap.ts";

const long = "This sentence is long enough to have been wrapped by an agent at its column,";

describe("unwrapAgentText", () => {
  test("joins a wrapped paragraph and a wrapped list item", () => {
    const text = `# Title\n\n${long}\nand it goes on here.\n\n- ${long}\n  still the same item.\n- short item\n`;
    expect(unwrapAgentText(null, text)).toBe(`# Title\n\n${long} and it goes on here.\n\n- ${long} still the same item.\n- short item\n`);
  });

  test("joins several continuation lines", () => {
    expect(unwrapAgentText(null, `${long}\n${long}\nend.`)).toBe(`${long} ${long} end.`);
  });

  test("keeps short lines, blocks, hard breaks", () => {
    const keep = [
      "Short line\nnext line",
      `${long}\n- a list item`,
      `${long}\n## Heading`,
      `${long}\n> quote`,
      `${long}\n| a | b |`,
      `${long}  \nafter a hard break`,
      `${long}\\\nafter a backslash break`,
      `${long}\n\nnew paragraph`,
      `| ${long} |\n| next row |`,
    ];
    for (const t of keep) expect(unwrapAgentText(null, t)).toBe(t);
  });

  test("leaves code fences and front matter alone", () => {
    const t = `---\ntitle: ${long}\ntags: x\n---\n\n\`\`\`\n${long}\nnext code line\n\`\`\`\n`;
    expect(unwrapAgentText(null, t)).toBe(t);
  });

  test("only joins lines the agent added", () => {
    const base = `${long}\nkept as people wrote it.\n`;
    // the agent appends a wrapped paragraph and leaves the people's lines
    const text = `${base}\n${long}\njoined.\n`;
    expect(unwrapAgentText(base, text)).toBe(`${base}\n${long} joined.\n`);
  });
});
