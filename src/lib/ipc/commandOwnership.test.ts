// IPC 커맨드 소유권 — 도메인 분할(2026-08-01) 후의 불변식 두 가지.
//
// 1) 하나의 Tauri 커맨드는 정확히 한 도메인 파일이 래핑한다. 분할 전에는
//    단일 파일이라 중복이 물리적으로 불가능했지만, 분할 후에는 두 파일이
//    같은 커맨드를 각자 래핑하는 사고(계약이 갈라지는 지점)가 가능해진다.
// 2) barrel(src/lib/ipc.ts)은 재-export만 한다 — 래퍼를 barrel에 직접
//    추가하면 도메인 소유권이 무너진다.
//
// 스캔은 TS AST로 한다 — 정규식은 객체 리터럴 제네릭(`invoke<{ a: string;
// b: string }>(...)`)의 세미콜론에서 끊겨 create_worktree 등 2개 커맨드를
// 놓쳤다(랜딩 리뷰 발견 F1). 커맨드가 삼항식 등 비-리터럴 인자인 호출은
// 소유권 판정 대상이 아니다(리터럴 첫 인자만 계약으로 본다).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

function commandsIn(source: string, fileName: string): string[] {
	const sourceFile = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const commands: string[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "invoke" &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			commands.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return commands;
}

describe("ipc command ownership", () => {
	it("각 Tauri 커맨드는 정확히 한 도메인 파일이 래핑한다", () => {
		const owners = new Map<string, Set<string>>();
		for (const file of readdirSync(here("."))) {
			if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
			const source = readFileSync(here(`./${file}`), "utf8");
			for (const command of commandsIn(source, file)) {
				const set = owners.get(command) ?? new Set<string>();
				set.add(file);
				owners.set(command, set);
			}
		}
		const duplicated = [...owners.entries()]
			.filter(([, files]) => files.size > 1)
			.map(([command, files]) => `${command} ← ${[...files].join(", ")}`);
		expect(duplicated).toEqual([]);
		// 회귀 방지용 하한 — 스캔 자체가 조용히 깨지면 0개로도 통과해버린다.
		// AST 실측(2026-08-01): 리터럴 커맨드 174개.
		expect(owners.size).toBeGreaterThan(150);
	});

	it("barrel은 재-export만 한다 — invoke 호출 금지", () => {
		const barrel = readFileSync(here("../ipc.ts"), "utf8");
		expect(commandsIn(barrel, "ipc.ts")).toEqual([]);
		expect(barrel).not.toContain("invoke(");
	});
});
