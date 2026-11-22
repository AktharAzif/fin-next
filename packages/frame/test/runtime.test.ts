// The runtime's stores: the viewer as the frame holds it, reloaded after anything that changes it.
import { describe, expect, it } from "vitest";
import { createViewerStore } from "../src/runtime/viewer.ts";

/** A load whose answers the test hands out one by one, in any order. */
function heldLoads<V>() {
  const answers: { resolve: (value: V | null) => void; reject: (error: unknown) => void }[] = [];
  const load = () =>
    new Promise<V | null>((resolve, reject) => {
      answers.push({ resolve, reject });
    });
  return { load, answers };
}

describe("the viewer store", () => {
  it("stores what a reload fetched", async () => {
    const store = createViewerStore<string>("before", async () => "after");
    await expect(store.reload()).resolves.toBe("after");
    expect(store.get()).toBe("after");
  });

  it("keeps the newest reload's answer when an older one answers last", async () => {
    const { load, answers } = heldLoads<string>();
    const store = createViewerStore<string>("org_1", load);
    const older = store.reload();
    const newer = store.reload();
    answers[1]?.resolve("org_2");
    await newer;
    expect(store.get()).toBe("org_2");
    answers[0]?.resolve("org_1");
    await older;
    expect(store.get()).toBe("org_2");
  });

  it("does not store an older answer while a newer reload is still in flight", async () => {
    const { load, answers } = heldLoads<string>();
    const store = createViewerStore<string>("org_1", load);
    const older = store.reload();
    const newer = store.reload();
    answers[0]?.resolve("stale");
    await older;
    expect(store.get()).toBe("org_1");
    answers[1]?.resolve(null);
    await newer;
    expect(store.get()).toBeNull();
  });

  it("keeps the stored viewer when a reload fails, and passes the failure on", async () => {
    const { load, answers } = heldLoads<string>();
    const store = createViewerStore<string>("org_1", load);
    const reload = store.reload();
    answers[0]?.reject(new TypeError("Failed to fetch"));
    await expect(reload).rejects.toThrow(TypeError);
    expect(store.get()).toBe("org_1");
  });
});
