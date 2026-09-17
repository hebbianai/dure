// @vitest-environment jsdom
// 이 페이지의 존재 이유가 "설치한 CLI로 이 앱이 무엇을 할 수 있는지"라서,
// 열거 대상이 계정 지원 셋으로 좁혀지면 나머지 CLI는 물어볼 곳이 사라진다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	providerPreflight: vi.fn(async () => {
		throw new Error("no backend in test");
	}),
	providerWiringStatus: vi.fn(async () => {
		throw new Error("no backend in test");
	}),
	providerWiringFile: vi.fn(async () => {
		throw new Error("no backend in test");
	}),
}));

import { ProvidersPage } from "@/components/settings/ProvidersPage";
import { accountProviders } from "@/lib/agents/providers";
import { useStore } from "@/store";
import { PROVIDERS, type Provider } from "@/types";

const setInstalled = (providers: Provider[]) => {
	useStore.setState({ installedAgents: providers });
};

beforeEach(() => {
	useStore.setState({ uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" } });
	setInstalled([]);
});
afterEach(() => {
	cleanup();
	useStore.setState({ installedAgents: [] });
});

describe("ProvidersPage 열거", () => {
	it("설치가 감지된 CLI를 계정 지원 여부와 무관하게 싣는다", async () => {
		setInstalled(["goose", "amp"]);
		render(<ProvidersPage />);
		await waitFor(() => expect(screen.getByText(PROVIDERS.goose.label)).toBeTruthy());
		expect(screen.getByText(PROVIDERS.amp.label)).toBeTruthy();
		// core 셋은 감지와 무관하게 항상 실린다.
		for (const provider of accountProviders()) {
			expect(screen.getByText(PROVIDERS[provider].label)).toBeTruthy();
		}
		// 설치가 감지되지 않은 비-core는 싣지 않는다.
		expect(screen.queryByText(PROVIDERS.kilocode.label)).toBeNull();
	});

	// 계정 분리를 못 하는 provider에 "시스템 기본값" 행을 그리면 계정 기능이
	// 있는 것처럼 읽힌다.
	it("계정 분리를 지원하지 않는 provider에는 활성 계정 행을 그리지 않는다", async () => {
		setInstalled(["goose"]);
		render(<ProvidersPage />);
		await waitFor(() => expect(screen.getByText(PROVIDERS.goose.label)).toBeTruthy());
		const section = screen.getByText(PROVIDERS.goose.label).closest("section") as HTMLElement;
		expect(within(section).queryByText("활성 계정")).toBeNull();
		const claude = screen.getByText(PROVIDERS.claude.label).closest("section") as HTMLElement;
		expect(within(claude).getByText("활성 계정")).toBeTruthy();
	});
});

describe("ProvidersPage 능력 표", () => {
	it("provider마다 능력 점수를 낸다", async () => {
		setInstalled([]);
		render(<ProvidersPage />);
		await waitFor(() => expect(screen.getAllByText("이 앱이 쓸 수 있는 것").length).toBeGreaterThan(0));
		expect(screen.getAllByText("이 앱이 쓸 수 있는 것")).toHaveLength(accountProviders().length);
	});

	it("지원하는 능력은 그것을 수행하는 명령을 함께 보여준다", async () => {
		setInstalled([]);
		render(<ProvidersPage />);
		const claude = await waitFor(
			() => screen.getByText(PROVIDERS.claude.label).closest("section") as HTMLElement,
		);
		expect(within(claude).getByText("이어서 하기")).toBeTruthy();
		// "지원함"만 쓰면 그게 무엇으로 되는지 알 수 없다.
		expect(within(claude).getByText(PROVIDERS.claude.resumeCmd as string)).toBeTruthy();
	});
});

it("does not expose installed Pro-only provider settings in Basic", async () => {
	useStore.setState({
		installedAgents: ["gemini"],
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
	});
	render(<ProvidersPage />);
	await waitFor(() =>
		expect(screen.getByText(PROVIDERS.claude.label)).toBeTruthy(),
	);
	expect(screen.queryByText(PROVIDERS.gemini.label)).toBeNull();
});
