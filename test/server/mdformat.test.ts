import { describe, expect, test } from "bun:test";
import { formatAgentMarkdown } from "../../src/server/mdformat.ts";

describe("formatAgentMarkdown", () => {
  test("unwraps and puts one sentence per line", async () => {
    const text = "# Why? Because\n\nThe first sentence is here. The second one\nwraps onto the next line.\n\n- An item. With two\n  sentences.\n";
    expect(await formatAgentMarkdown(null, text)).toBe("# Why? Because\n\nThe first sentence is here.\nThe second one wraps onto the next line.\n\n- An item.\n  With two sentences.\n");
  });

  test("leaves code, front matter and tables alone", async () => {
    const text = "---\ntitle: A. B\n---\n\n```\nOne. Two\nthree\n```\n\n| a. B | c |\n|---|---|\n| 1 | 2 |\n";
    expect(await formatAgentMarkdown(null, text)).toBe(text);
  });

  test("only formats blocks the agent wrote", async () => {
    const base = "People wrote this. On purpose\nlike this.\n";
    const text = `${base}\nThe agent wrote this. And\nwrapped it.\n`;
    expect(await formatAgentMarkdown(base, text)).toBe(`${base}\nThe agent wrote this.\nAnd wrapped it.\n`);
  });

  test("a block the agent only partly changed stays", async () => {
    const base = "Line one. Two\nline two.\n";
    const text = "Line one. Two\nline 2.\n";
    expect(await formatAgentMarkdown(base, text)).toBe(text);
  });
});
