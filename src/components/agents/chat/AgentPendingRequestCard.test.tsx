// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import type { AgentPendingRequestV1 } from "@/lib/agents/chat/agentConversationContract";
import { t } from "@/lib/i18n";

function pending(
	kind: "permission" | "question",
	payload: unknown,
	requestId = "request-1",
): AgentPendingRequestV1 {
	return {
		interactionSessionId: "interaction-1",
		runtime: {
			runtimeGeneration: "runtime-1",
			providerEpoch: "query-1",
		},
		request: {
			requestId,
			kind,
			turnId: null,
			clientMessageId: "message-1",
			payload,
			createdAtMs: 1,
		},
	};
}

function questionPayload(question = "Which database should we use?") {
	return {
		toolName: "AskUserQuestion",
		input: {
			questions: [
				{
					header: "Database",
					multiSelect: false,
					options: [
						{
							description: "Use the local database",
							label: "SQLite",
						},
						{
							description: "Use the server database",
							label: "Postgres",
						},
					],
					question,
				},
			],
		},
	};
}

describe("AgentPendingRequestCard", () => {
	afterEach(cleanup);

	it.each(["permission", "question"] as const)(
		"defers a collapsed %s payload across 20 updates and shows current JSON when expanded",
		async (kind) => {
			const serialized = vi.fn();
			const largeText = "x".repeat(32 * 1024);
			const payload = (revision: string) => {
				const value = {
					...(kind === "question"
						? questionPayload()
						: { toolName: "Bash", input: { command: "pwd" } }),
					largeText,
					revision,
				};
				return {
					...value,
					toJSON: () => {
						serialized();
						return value;
					},
				};
			};
			const onAnswer = vi.fn();
			const content = (value: unknown, busy = false) => (
				<AgentPendingRequestCard
					pending={pending(kind, value)}
					busy={busy}
					onAnswer={onAnswer}
				/>
			);
			const initial = payload("initial");
			const view = render(null);
			for (let update = 0; update < 20; update += 1) {
				view.rerender(content(initial, update % 2 === 0));
			}
			expect(serialized.mock.calls).toHaveLength(0);
			expect(view.container.querySelector("pre")).toBeNull();
			const summary = screen.getByText(t("agents.chat.requestDetails"));
			fireEvent.click(summary);
			await waitFor(() =>
				expect(view.container.querySelector("pre")?.textContent).toContain(
					'"revision": "initial"',
				),
			);
			expect(serialized.mock.calls).toHaveLength(1);
			expect(view.container.querySelector("pre")?.textContent).toContain(
				largeText,
			);
			view.rerender(content(payload("expanded update")));
			expect(view.container.querySelector("pre")?.textContent).toContain(
				'"revision": "expanded update"',
			);

			fireEvent.click(summary);
			await waitFor(() =>
				expect(view.container.querySelector("pre")).toBeNull(),
			);
			serialized.mockClear();
			const latest = payload("latest");
			for (let update = 0; update < 20; update += 1) {
				view.rerender(content(latest, update % 2 === 0));
			}
			expect(serialized.mock.calls).toHaveLength(0);
			fireEvent.click(summary);
			await waitFor(() =>
				expect(view.container.querySelector("pre")?.textContent).toContain(
					'"revision": "latest"',
				),
			);
			expect(serialized.mock.calls).toHaveLength(1);
			expect(onAnswer).not.toHaveBeenCalled();
		},
	);

	it("projects permission presentation and an exact decision", () => {
		const onAnswer = vi.fn();
		render(
			<AgentPendingRequestCard
				pending={pending("permission", {
					presentation: {
						description: "Claude will inspect the working directory",
						title: "Run pwd",
					},
					toolName: "Bash",
				})}
				busy={false}
				onAnswer={onAnswer}
			/>,
		);

		expect(screen.getByText("Run pwd")).toBeTruthy();
		expect(
			screen.getByText("Claude will inspect the working directory"),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.allow") }),
		);
		expect(onAnswer).toHaveBeenCalledWith({ decision: "allow" });
	});

	it("submits an option under the exact question and separates its description", () => {
		const onAnswer = vi.fn();
		render(
			<AgentPendingRequestCard
				pending={pending("question", questionPayload())}
				busy={false}
				onAnswer={onAnswer}
			/>,
		);
		const sqlite = screen.getByRole("radio", {
			name: "SQLite",
		}) as HTMLInputElement;
		const description = screen.getByText("Use the local database");
		expect(sqlite.getAttribute("aria-describedby")).toBe(description.id);
		sqlite.focus();
		fireEvent.click(sqlite);
		expect(document.activeElement).toBe(sqlite);
		expect(sqlite.checked).toBe(true);
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.submitAnswer") }),
		);

		expect(onAnswer).toHaveBeenCalledWith({
			answers: { "Which database should we use?": "SQLite" },
		});
	});

	it("supports provider-order multi-select and a mutually exclusive Other answer", () => {
		const onAnswer = vi.fn();
		render(
			<AgentPendingRequestCard
				pending={pending("question", {
					input: {
						questions: [
							{
								multiSelect: true,
								options: [{ label: "Read" }, { label: "Test" }],
								question: "Which checks should run?",
							},
							{
								allowOther: true,
								multiSelect: false,
								options: [{ label: "Known target" }],
								question: "Which target should we use?",
							},
						],
					},
				})}
				busy={false}
				onAnswer={onAnswer}
			/>,
		);

		fireEvent.click(screen.getByRole("checkbox", { name: "Read" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Test" }));
		const knownTarget = screen.getByRole("radio", {
			name: "Known target",
		}) as HTMLInputElement;
		fireEvent.click(knownTarget);
		fireEvent.change(screen.getByLabelText(t("agents.chat.otherAnswer")), {
			target: { value: "Fresh target" },
		});
		expect(knownTarget.checked).toBe(false);
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.submitAnswer") }),
		);

		expect(onAnswer).toHaveBeenCalledWith({
			answers: {
				"Which checks should run?": "Read, Test",
				"Which target should we use?": "Fresh target",
			},
		});
	});

	it("declines a valid question without manufacturing an answer", () => {
		const onAnswer = vi.fn();
		render(
			<AgentPendingRequestCard
				pending={pending("question", questionPayload())}
				busy={false}
				onAnswer={onAnswer}
			/>,
		);

		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.declineQuestion") }),
		);
		expect(onAnswer).toHaveBeenCalledWith({ decision: "deny" });
	});

	it("keeps malformed payload inspectable and offers only an explicit decline", () => {
		render(
			<AgentPendingRequestCard
				pending={pending("question", {
					input: { questions: [{ malformed: true }] },
				})}
				busy={false}
				onAnswer={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: t("agents.chat.submitAnswer") }),
		).toBeNull();
		expect(screen.getByText(t("agents.chat.requestDetails"))).toBeTruthy();
		expect(
			screen.getByRole("button", { name: t("agents.chat.declineQuestion") }),
		).toBeTruthy();
	});

	it("never captures or persists a provider-declared secret answer", () => {
		const onAnswer = vi.fn();
		render(
			<AgentPendingRequestCard
				pending={pending("question", {
					input: {
						questions: [
							{
								id: "token",
								isSecret: true,
								options: [],
								question: "API token?",
							},
						],
					},
				})}
				busy={false}
				onAnswer={onAnswer}
			/>,
		);

		expect(document.querySelector("input, textarea")).toBeNull();
		expect(
			screen.queryByRole("button", { name: t("agents.chat.submitAnswer") }),
		).toBeNull();
		expect(
			screen.getByText(t("agents.chat.sensitiveAnswerUnsupported")),
		).toBeTruthy();
		fireEvent.click(
			screen.getByRole("button", { name: t("agents.chat.declineQuestion") }),
		);
		expect(onAnswer).toHaveBeenCalledWith({ decision: "deny" });
	});

	it("disables every answer control while the controller lane is busy", () => {
		render(
			<AgentPendingRequestCard
				pending={pending("question", {
					input: {
						questions: [
							{
								allowOther: true,
								options: [{ label: "SQLite" }],
								question: "Database?",
							},
						],
					},
				})}
				busy
				onAnswer={vi.fn()}
			/>,
		);

		for (const control of [
			...screen.getAllByRole("radio"),
			...screen.getAllByRole("textbox"),
			...screen.getAllByRole("button"),
		]) {
			expect((control as HTMLInputElement | HTMLButtonElement).disabled).toBe(
				true,
			);
		}
	});

	it("names simultaneous question regions by their first exact question", () => {
		render(
			<>
				<AgentPendingRequestCard
					pending={pending("question", questionPayload(), "request-1")}
					busy={false}
					onAnswer={vi.fn()}
				/>
				<AgentPendingRequestCard
					pending={pending(
						"question",
						questionPayload("Which runtime should we use?"),
						"request-2",
					)}
					busy={false}
					onAnswer={vi.fn()}
				/>
			</>,
		);

		expect(
			screen.getByRole("region", { name: /Which database should we use/ }),
		).toBeTruthy();
		expect(
			screen.getByRole("region", { name: /Which runtime should we use/ }),
		).toBeTruthy();
	});

	it("wraps provider text and actions inside a narrow card", () => {
		const longQuestion = "WhichDatabase".repeat(24);
		render(
			<AgentPendingRequestCard
				pending={pending("question", questionPayload(longQuestion))}
				busy={false}
				onAnswer={vi.fn()}
			/>,
		);

		const card = screen.getByText(longQuestion).closest("section");
		expect(card?.className).toContain("[overflow-wrap:anywhere]");
		const actions = screen.getByRole("button", {
			name: t("agents.chat.submitAnswer"),
		}).parentElement;
		expect(actions?.className).toContain("flex-wrap");
	});
});
