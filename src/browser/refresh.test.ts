import { describe, expect, it, vi } from "vitest";
import { coalesceRefresh, singleFlightUntilSuccess } from "./refresh.js";

it("coalesces bursts and repeats once for changes during a read", async () => {
  let release!: () => void;
  const action = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
    .mockResolvedValue(undefined);
  const refresh = coalesceRefresh(action);
  const first = refresh();
  expect(refresh()).toBe(first);
  await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  expect(refresh()).toBe(first);
  refresh();
  release();
  await first;
  expect(action).toHaveBeenCalledTimes(2);
  action.mockRejectedValueOnce(new Error("offline"));
  await expect(refresh()).rejects.toThrow("offline");
  await refresh();
  expect(action).toHaveBeenCalledTimes(4);
});

describe("singleFlightUntilSuccess", () => {
  it("shares one success and starts again after a failure", async () => {
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("Failed to fetch");
      return `runtime-${calls}`;
    });
    const get = singleFlightUntilSuccess(start);

    await expect(get()).rejects.toThrow("Failed to fetch");
    const [first, second] = await Promise.all([get(), get()]);
    expect(first).toBe("runtime-2");
    expect(second).toBe("runtime-2");
    await expect(get()).resolves.toBe("runtime-2");
    expect(start).toHaveBeenCalledTimes(2);
  });
});
