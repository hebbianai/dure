// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "@/lib/i18n";
import { QuickCommandDialog } from "./QuickCommandDialog";

beforeEach(() => setLang("en"));
afterEach(cleanup);
describe("Quick Command editor", () => {
	it("keeps oversized text intact and refuses to save a truncated command", () => {
		const save = vi.fn();
		render(
			<QuickCommandDialog
				editor="new"
				commands={[]}
				onEditorChange={vi.fn()}
				onSave={save}
				onRemove={vi.fn()}
				onMove={vi.fn()}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Label"), {
			target: { value: "Long command" },
		});
		const text = "a".repeat(16_001);
		const input = screen.getByLabelText(
			"Command or prompt",
		) as HTMLTextAreaElement;
		fireEvent.change(input, { target: { value: text } });
		expect(input.value).toBe(text);
		expect(input.hasAttribute("maxlength")).toBe(false);
		expect(screen.getByRole("alert").textContent).toContain("16,000");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).not.toHaveBeenCalled();
	});
	it("saves a reusable prompt without running it and makes Enter opt-in", () => {
		const save = vi.fn();
		render(
			<QuickCommandDialog
				editor="new"
				commands={[]}
				onEditorChange={vi.fn()}
				onSave={save}
				onRemove={vi.fn()}
				onMove={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
		).toBe(true);
		fireEvent.change(screen.getByLabelText("Label"), {
			target: { value: "Review" },
		});
		const text = "/goal Review this workspace\n  src/\n";
		fireEvent.change(screen.getByLabelText("Command or prompt"), {
			target: { value: text },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ label: "Review", text, appendEnter: false }),
		);
	});
	it("edits the same ID and saves through Command-Enter", () => {
		const command = {
			id: "existing",
			label: "Status",
			text: "git status",
			appendEnter: false,
		};
		const save = vi.fn();
		render(
			<QuickCommandDialog
				editor={command}
				commands={[command]}
				onEditorChange={vi.fn()}
				onSave={save}
				onRemove={vi.fn()}
				onMove={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("switch"));
		fireEvent.keyDown(screen.getByLabelText("Command or prompt"), {
			key: "Enter",
			metaKey: true,
		});
		expect(save).toHaveBeenCalledWith({ ...command, appendEnter: true });
	});
	it("confirms removal inline and never removes on Cancel", () => {
		const command = {
			id: "existing",
			label: "Status",
			text: "git status",
			appendEnter: false,
		};
		const remove = vi.fn();
		render(
			<QuickCommandDialog
				editor="manage"
				commands={[command]}
				onEditorChange={vi.fn()}
				onSave={vi.fn()}
				onRemove={remove}
				onMove={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(remove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(remove).toHaveBeenCalledWith("existing");
	});
});
