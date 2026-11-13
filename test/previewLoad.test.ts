import { afterEach, expect, test, vi } from "vitest";
import { PreviewLoadMonitor } from "../src/hub/previewLoad.js";

afterEach(() => vi.useRealTimers());

test("遅延採取・5 秒ごとの判定・混雑時だけ間引く・ヒステリシス・遷移時だけログ", async () => {
  vi.useFakeTimers();
  let delayMs = 20;
  const histogram = {
    enable: vi.fn(), disable: vi.fn(), reset: vi.fn(),
    percentile: vi.fn(() => delayMs * 1_000_000),
  };
  const createHistogram = vi.fn(() => histogram);
  const log = vi.fn();
  const monitor = new PreviewLoadMonitor({ createHistogram, log, now: Date.now });
  expect(createHistogram).not.toHaveBeenCalled();
  expect(monitor.intervalMs(1000)).toBe(1000);
  expect(histogram.enable).toHaveBeenCalledTimes(1);
  delayMs = 150;
  await vi.advanceTimersByTimeAsync(4999);
  expect(monitor.intervalMs(1000)).toBe(1000);
  await vi.advanceTimersByTimeAsync(1);
  expect(monitor.intervalMs(1000)).toBe(3000);
  expect(monitor.intervalMs(5000)).toBe(5000);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenLastCalledWith("audit preview-load-shed state=congested p95Ms=150");
  delayMs = 70;
  await vi.advanceTimersByTimeAsync(5000);
  expect(monitor.intervalMs(1000)).toBe(3000);
  expect(log).toHaveBeenCalledTimes(1);
  delayMs = 20;
  await vi.advanceTimersByTimeAsync(5000);
  expect(monitor.intervalMs(1000)).toBe(1000);
  expect(log).toHaveBeenCalledTimes(2);
  expect(log).toHaveBeenLastCalledWith("audit preview-load-shed state=normal p95Ms=20");
  expect(histogram.percentile).toHaveBeenCalledWith(95);
  expect(histogram.reset).toHaveBeenCalledTimes(3);
  monitor.close();
  expect(histogram.disable).toHaveBeenCalledTimes(1);
  expect(monitor.intervalMs(1000)).toBe(1000);
  expect(createHistogram).toHaveBeenCalledTimes(1);
});

test("一覧取得が無ければ採取を始めずに閉じられる", () => {
  const createHistogram = vi.fn();
  const monitor = new PreviewLoadMonitor({ createHistogram });
  monitor.close();
  expect(monitor.intervalMs(1000)).toBe(1000);
  expect(createHistogram).not.toHaveBeenCalled();
});
