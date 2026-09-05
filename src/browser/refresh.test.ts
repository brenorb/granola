import { expect, it, vi } from "vitest";
import { coalesceRefresh } from "./refresh.js";

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
