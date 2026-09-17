import { describe, expect, it } from "vitest";
import { createKeyboardHeightRecorder, KEYBOARD_HEIGHT_PROPERTY } from "./keyboardHeight";

function memory(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

const heightOf = (root: HTMLElement) => root.style.getPropertyValue(KEYBOARD_HEIGHT_PROPERTY);

describe("keyboard height", () => {
  it("publishes the remembered height before any keyboard shows", () => {
    const root = document.createElement("div");
    createKeyboardHeightRecorder(root, memory({ "dure.keyboardHeight.v1": "336" }));
    expect(heightOf(root)).toBe("336px");
  });

  it("publishes nothing when nothing is remembered", () => {
    const root = document.createElement("div");
    createKeyboardHeightRecorder(root, memory());
    expect(heightOf(root)).toBe("");
  });

  it("records what the keyboard covers and remembers it", () => {
    const root = document.createElement("div");
    const storage = memory();
    const recorder = createKeyboardHeightRecorder(root, storage);
    recorder.observe(0);
    expect(heightOf(root)).toBe("");
    recorder.observe(366.6);
    expect(heightOf(root)).toBe("367px");
    expect(storage.store.get("dure.keyboardHeight.v1")).toBe("367");
  });

  it("keeps the tallest reading of one showing and starts over on the next", () => {
    const root = document.createElement("div");
    const recorder = createKeyboardHeightRecorder(root, memory());
    recorder.observe(300);
    recorder.observe(340);
    recorder.observe(320);
    expect(heightOf(root)).toBe("340px");
    recorder.observe(0);
    recorder.observe(280);
    expect(heightOf(root)).toBe("280px");
  });

  it("ignores a remembered value that is not a height", () => {
    const root = document.createElement("div");
    createKeyboardHeightRecorder(root, memory({ "dure.keyboardHeight.v1": "tall" }));
    expect(heightOf(root)).toBe("");
  });

  it("survives a storage that throws", () => {
    const root = document.createElement("div");
    const broken = {
      getItem: () => {
        throw new Error("no site data");
      },
      setItem: () => {
        throw new Error("no site data");
      },
    };
    const recorder = createKeyboardHeightRecorder(root, broken);
    recorder.observe(336);
    expect(heightOf(root)).toBe("336px");
  });
});
