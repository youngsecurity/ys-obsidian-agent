/**
 * Strict JSONL record splitter (design doc gotcha 2).
 *
 * Pi RPC framing uses LF as the only record delimiter. A trailing CR is
 * stripped. Generic line readers (e.g. Node readline) are not protocol
 * compliant because they also split on U+2028/U+2029, which are valid
 * inside JSON strings.
 */
export class JsonlSplitter {
  private buffer = "";

  /** Feed a decoded chunk; returns zero or more complete records. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const records: string[] = [];
    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) records.push(line);
    }
    return records;
  }

  /** Flush any trailing partial record at stream end. */
  end(): string[] {
    if (this.buffer.length === 0) return [];
    let line = this.buffer;
    this.buffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    return line.length > 0 ? [line] : [];
  }
}
