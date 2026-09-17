import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { connectWorkspaceEnvironment } from "@/lib/environments/connectWorkspaceEnvironment";
import { useWorkspaceEnvironments } from "@/lib/environments/useWorkspaceEnvironments";
import {
	environmentPending,
	type WorkspaceEnvironment,
} from "@/lib/environments/workspaceEnvironmentContract";
import { t } from "@/lib/i18n";
import {
	type CreateEnvironmentRequest,
	createEnvironment,
	environmentRecipes,
	type RecipeSnapshot,
} from "@/lib/ipc/dureWorkspaceEnvironment";
import type { Project } from "@/types";

export function EnvironmentLauncher({
	project,
	onReady,
}: {
	project: Project;
	onReady: (project: Project) => void;
}) {
	const [open, setOpen] = useState(false);
	const [recipes, setRecipes] = useState<RecipeSnapshot | null>(null);
	const [selected, setSelected] = useState("");
	const [name, setName] = useState(project.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [created, setCreated] = useState<WorkspaceEnvironment | null>(null);
	const attempt = useRef<CreateEnvironmentRequest | null>(null);
	const {
		snapshot,
		refresh,
		error: loadError,
	} = useWorkspaceEnvironments(open);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const current = snapshot
		? (snapshot.environments.find((item) => item.id === created?.id) ?? null)
		: created;

	const load = async () => {
		setOpen(true);
		setBusy(true);
		setError(false);
		try {
			const next = await environmentRecipes(project.path);
			setRecipes(next);
			setSelected(next.recipes[0]?.id ?? "");
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	const prepare = async () => {
		const recipe = recipes?.recipes.find((item) => item.id === selected);
		if (!recipes || !recipe || !recipes.proAvailable) return;
		setBusy(true);
		setError(false);
		attempt.current ??= {
			projectPath: project.path,
			recipeId: recipe.id,
			recipeDigest: recipe.digest,
			name: name.trim(),
			idempotencyKey: crypto.randomUUID(),
		};
		try {
			const environment = await createEnvironment(
				attempt.current,
				recipes.authority,
			);
			if (mounted.current) {
				setCreated(environment);
				await refresh();
			}
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	const connect = async () => {
		if (!current) return;
		setBusy(true);
		setError(false);
		try {
			const remote = await connectWorkspaceEnvironment(current);
			if (mounted.current) onReady(remote);
		} catch {
			setError(true);
		} finally {
			setBusy(false);
		}
	};
	if (!open)
		return (
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="self-start"
				onClick={() => void load()}
			>
				{t("environments.useVm")}
			</Button>
		);
	return (
		<section
			className="flex flex-col gap-2"
			aria-label={t("environments.title")}
		>
			<span className="text-xs font-medium">{t("environments.useVm")}</span>
			<p className="text-xs text-muted-foreground">
				{t("environments.recipeNotice")}
			</p>
			{recipes && !recipes.proAvailable && (
				<p className="text-xs text-muted-foreground">
					{t("environments.proRequired")}
				</p>
			)}
			{recipes?.recipes.length === 0 && (
				<p className="text-xs text-muted-foreground">
					{t("environments.noRecipes")}
				</p>
			)}
			{recipes && recipes.recipes.length > 0 && !current && (
				<>
					<SelectField
						aria-label={t("environments.recipe")}
						value={selected}
						onValueChange={setSelected}
						disabled={busy || Boolean(attempt.current)}
					>
						{recipes.recipes.map((recipe) => (
							<SelectOption key={recipe.id} value={recipe.id}>
								{recipe.name}
							</SelectOption>
						))}
					</SelectField>
					<Input
						aria-label={t("environments.name")}
						value={name}
						maxLength={128}
						disabled={busy || Boolean(attempt.current)}
						onChange={(event) => setName(event.target.value)}
					/>
					<Button
						type="button"
						size="sm"
						className="self-start"
						disabled={busy || !recipes.proAvailable || !name.trim()}
						onClick={() => void prepare()}
					>
						{t(attempt.current ? "common.retry" : "environments.prepare")}
					</Button>
				</>
			)}
			{current && (
				<>
					<p className="text-xs" role="status">
						{t(`environments.status.${current.status}`)}
					</p>
					<p className="text-xs text-muted-foreground">
						{t("environments.manageHint")}
					</p>
					{current.status === "running" && (
						<Button
							type="button"
							size="sm"
							className="self-start"
							disabled={busy || Boolean(loadError)}
							onClick={() => void connect()}
						>
							{t("environments.continue")}
						</Button>
					)}
					{!environmentPending(current) && current.error && (
						<ErrorText>{t("environments.providerFailed")}</ErrorText>
					)}
				</>
			)}
			{(error || Boolean(loadError)) && (
				<ErrorText>{t("environments.failed")}</ErrorText>
			)}
			{(Boolean(loadError) || (error && !recipes)) && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => void (recipes ? refresh().catch(() => {}) : load())}
				>
					{t("common.retry")}
				</Button>
			)}
		</section>
	);
}
