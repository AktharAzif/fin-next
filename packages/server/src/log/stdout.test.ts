import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { type LineStream, streamWriter } from "./stdout.ts";

/** A stream that records its writes, and fails as a pipe does when told to. */
function fakeStream(): LineStream & {
  written: string[];
  emitter: EventEmitter;
  throwOnWrite: boolean;
} {
  const emitter = new EventEmitter();
  const stream = {
    written: [] as string[],
    emitter,
    throwOnWrite: false,
    write(chunk: string): boolean {
      if (stream.throwOnWrite) throw Object.assign(new Error("write EBADF"), { code: "EBADF" });
      stream.written.push(chunk);
      return true;
    },
    on(event: "error", listener: (error: unknown) => void): unknown {
      return emitter.on(event, listener);
    },
  };
  return stream;
}

describe("streamWriter", () => {
  it("writes one line per call, then stops for good at the stream's first error", () => {
    const stream = fakeStream();
    const failures: string[] = [];
    const write = streamWriter(stream, (code) => failures.push(code));
    write("one");
    // As Node reports a pipe whose reader has gone; with no listener this would be thrown.
    expect(() =>
      stream.emitter.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })),
    ).not.toThrow();
    write("two");
    stream.emitter.emit("error", new Error("again"));
    expect(stream.written).toEqual(["one\n"]);
    expect(failures).toEqual(["EPIPE"]);
  });

  it("never throws: a write that throws counts as the failure", () => {
    const stream = fakeStream();
    const failures: string[] = [];
    const write = streamWriter(stream, (code) => failures.push(code));
    stream.throwOnWrite = true;
    expect(() => write("one")).not.toThrow();
    stream.throwOnWrite = false;
    write("two");
    expect(stream.written).toEqual([]);
    expect(failures).toEqual(["EBADF"]);
  });

  it("names a failure only by Node's code, and survives a listener that throws", () => {
    const stream = fakeStream();
    const failures: string[] = [];
    const write = streamWriter(stream, (code) => {
      failures.push(code);
      throw new Error("listener");
    });
    expect(() =>
      stream.emitter.emit("error", Object.assign(new Error("x"), { code: "jane@example.com" })),
    ).not.toThrow();
    expect(() => write("one")).not.toThrow();
    expect(failures).toEqual(["unexpected"]);
  });
});
