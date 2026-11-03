import { afterEach, describe, expect, test, vi } from "vitest";
import {
  MASTER_SWITCH_KEY,
  loadEnabled,
  readEnabled,
  saveEnabled,
  watchEnabled,
} from "@/shared/master-switch";

/** chrome.storage.onChanged の listener の形 */
type Listener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readEnabled", () => {
  test("キーが無ければオン。warn しない (既定はオン)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(readEnabled(undefined)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("boolean はその値", () => {
    expect(readEnabled(false)).toBe(false);
    expect(readEnabled(true)).toBe(true);
  });

  test.each([["no"], [1], [null], [{}]])(
    "boolean でない値 (%j) は warn してオン (読めないときに拡張が黙って消えない)",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(readEnabled(value)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe("loadEnabled", () => {
  test("chrome.storage.local の enabled を読む", async () => {
    const get = vi.fn(async (_key: string) => ({ enabled: false }));
    vi.stubGlobal("chrome", { storage: { local: { get } } });

    expect(await loadEnabled()).toBe(false);
    expect(MASTER_SWITCH_KEY).toBe("enabled");
    expect(get).toHaveBeenCalledWith("enabled");
  });

  test("読めなくても reject せず、warn してオン", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (): Promise<never> => {
            throw new Error("読めない");
          },
        },
      },
    });

    await expect(loadEnabled()).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("saveEnabled", () => {
  test("chrome.storage.local の enabled に書く", async () => {
    const set = vi.fn(async (_items: Record<string, unknown>) => undefined);
    vi.stubGlobal("chrome", { storage: { local: { set } } });

    await saveEnabled(false);
    expect(set).toHaveBeenCalledWith({ enabled: false });
  });

  test("書けなければ reject をそのまま返す (popup が理由を出して表示を戻す)", async () => {
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          set: async (): Promise<never> => {
            throw new Error("書けない");
          },
        },
      },
    });

    await expect(saveEnabled(true)).rejects.toThrow("書けない");
  });
});

describe("watchEnabled", () => {
  test("local の enabled だけを拾う (sync の settings・local の windowLayout では呼ばない)。戻り値で外す", () => {
    const listeners: Listener[] = [];
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      storage: {
        onChanged: {
          addListener: (fn: Listener): void => {
            listeners.push(fn);
          },
          removeListener,
        },
      },
    });
    const fire: Listener = (changes, areaName) => {
      for (const listener of listeners) listener(changes, areaName);
    };
    const onChange = vi.fn();

    const unwatch = watchEnabled(onChange);
    fire({ settings: { newValue: {} } }, "sync");
    fire({ windowLayout: { newValue: {} } }, "local");
    fire({ enabled: { newValue: false } }, "sync");
    expect(onChange).not.toHaveBeenCalled();

    fire({ enabled: { newValue: false } }, "local");
    expect(onChange).toHaveBeenLastCalledWith(false);
    // キーを消した (既定 = オン)
    fire({ enabled: {} }, "local");
    expect(onChange).toHaveBeenLastCalledWith(true);

    unwatch();
    expect(removeListener).toHaveBeenCalledWith(listeners[0]);
  });
});
