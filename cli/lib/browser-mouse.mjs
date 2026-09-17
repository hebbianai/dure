export function browserMouse(values) {
  const [command, ...args] = values;
  const number = (value) => {
    if (typeof value !== "string" || !value.trim() || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > 1_000_000) throw new Error("browser_mouse_invalid");
    return Number(value);
  };
  let action;
  if (command === "move" && args.length === 2) {
    action = { kind: "move", x: number(args[0]), y: number(args[1]) };
  } else if (["down", "up"].includes(command) && args.length <= 1) {
    const button = args[0] ?? "left";
    if (!["left", "right", "middle", "back", "forward"].includes(button)) throw new Error("browser_mouse_invalid");
    action = { kind: command, button };
  } else if (command === "wheel" && args.length >= 1 && args.length <= 2) {
    action = { kind: "wheel", delta_y: number(args[0]), delta_x: number(args[1] ?? "0") };
  } else throw new Error("browser_mouse_invalid");
  return { kind: "mouse", action };
}
