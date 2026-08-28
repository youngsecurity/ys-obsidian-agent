import { describe, expect, test } from "bun:test";

import { JsonlSplitter } from "./jsonl";

describe("JsonlSplitter", () => {
  test("splits complete LF-delimited records", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("buffers partial records across chunks", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a"')).toEqual([]);
    expect(splitter.push(':1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(":2}\n")).toEqual(['{"b":2}']);
  });

  test("strips a trailing CR from CRLF input", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  test("does not split on U+2028 or U+2029 inside a record", () => {
    const splitter = new JsonlSplitter();
    const record = '{"text":"line\u2028sep\u2029end"}';
    expect(splitter.push(`${record}\n`)).toEqual([record]);
  });

  test("end() flushes a trailing partial record", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('{"a":1}')).toEqual([]);
    expect(splitter.end()).toEqual(['{"a":1}']);
    expect(splitter.end()).toEqual([]);
  });

  test("skips empty lines", () => {
    const splitter = new JsonlSplitter();
    expect(splitter.push('\n\n{"a":1}\n\n')).toEqual(['{"a":1}']);
  });
});
