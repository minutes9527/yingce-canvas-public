import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import localforage from "localforage";

import { localForageStorageForScope } from "../src/lib/localforage-storage";

let originalWindow: PropertyDescriptor | undefined;

beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
});

afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete (globalThis as { window?: unknown }).window;
});

test("localForage storage skips persistence outside the browser", async () => {
    delete (globalThis as { window?: unknown }).window;
    const storage = localForageStorageForScope("test");

    await expect(storage.getItem("state")).resolves.toBeNull();
    await expect(storage.setItem("state", "value")).resolves.toBeUndefined();
    await expect(storage.removeItem("state")).resolves.toBeUndefined();
});

test("browser storage failures propagate even when access to localStorage is blocked", async () => {
    const localStorageAccess = () => { throw new Error("localStorage access blocked"); };
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: Object.defineProperty({}, "localStorage", { get: localStorageAccess }),
    });
    const unavailable = new Error("persistent storage unavailable");
    const getItem = spyOn(localforage, "getItem").mockRejectedValue(unavailable);
    const setItem = spyOn(localforage, "setItem").mockRejectedValue(unavailable);
    const removeItem = spyOn(localforage, "removeItem").mockRejectedValue(unavailable);
    try {
        const storage = localForageStorageForScope("test");
        await expect(storage.getItem("state")).rejects.toBe(unavailable);
        await expect(storage.setItem("state", "value")).rejects.toBe(unavailable);
        await expect(storage.removeItem("state")).rejects.toBe(unavailable);
        expect(getItem).toHaveBeenCalledWith("state:user:test");
        expect(setItem).toHaveBeenCalledWith("state:user:test", "value");
        expect(removeItem).toHaveBeenCalledWith("state:user:test");
    } finally {
        getItem.mockRestore();
        setItem.mockRestore();
        removeItem.mockRestore();
    }
});
