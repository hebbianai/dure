import { useEffect, useId, useRef, useState } from "react";
import { Button, ConfirmationButton } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ErrorText } from "@/components/ui/error-text";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import type {
	BrowserPaneSession,
	BrowserPaneView,
} from "@/lib/browser/browserPaneSession";
import {
	type BrowserProfileRecord,
	isBrowserProfileLabel,
} from "@/lib/browser/browserProfileContract";
import { sameBrowserPage } from "@/lib/browser/browserResourceContract";
import { t } from "@/lib/i18n";

/** The parent keys this dialog by its exact page and controller generation. */
export function BrowserProfileDialog({
	session,
	view,
	enabled,
	onProfileDeleted,
}: {
	session: BrowserPaneSession;
	view: BrowserPaneView;
	enabled: boolean;
	onProfileDeleted: () => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [profiles, setProfiles] = useState<BrowserProfileRecord[]>();
	const [selected, setSelected] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<"request" | "created">();
	const [mode, setMode] = useState<"choose" | "create" | "delete">("choose");
	const [name, setName] = useState("");
	const [nativeUserAgent, setNativeUserAgent] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const mounted = useRef(false);
	const userAgentId = useId();
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const currentProfile = view.observation?.pages.find(
		(row) => row.page.page_id === view.page?.page_id,
	)?.profile_id;
	const selectedProfile = profiles?.find(
		(row) => row.profile.profileId === selected,
	);
	useEffect(() => {
		if (!open) return;
		let current = true;
		setProfiles(undefined);
		setFailure(undefined);
		void session.client.profiles().then(
			(rows) => {
				if (!current) return;
				setProfiles(rows);
				setSelected(
					rows.some(
						(row) =>
							row.state !== "deleted" &&
							row.profile.profileId === currentProfile,
					)
						? currentProfile!
						: "",
				);
			},
			() => {
				if (current) setFailure("request");
			},
		);
		return () => {
			current = false;
		};
	}, [open, session, currentProfile]);
	const admittedPage = () => {
		const page = view.page;
		const lease = view.control?.controller;
		const observed = session.read();
		if (
			!enabled ||
			!page ||
			!lease ||
			!observed.page ||
			!sameBrowserPage(observed.page, page) ||
			observed.control?.controller?.controller_id !== lease.controller_id ||
			observed.control?.controller?.epoch !== lease.epoch
		)
			return undefined;
		return page;
	};
	const change = async (kind: "profile_set" | "profile_clone") => {
		const page = admittedPage();
		if (busy || !page || selectedProfile?.state !== "active") return;
		setBusy(true);
		setFailure(undefined);
		try {
			await session.input({ kind, profile_id: selected }, page);
			if (mounted.current) setOpen(false);
		} catch {
			if (mounted.current) setFailure("request");
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	const create = async () => {
		const label = name.trim();
		const page = admittedPage();
		if (busy || !page || !isBrowserProfileLabel(label)) return;
		setBusy(true);
		setFailure(undefined);
		let created = false;
		try {
			const row = await session.client.createProfile(
				label,
				nativeUserAgent ? "native" : "clean",
				crypto.randomUUID(),
			);
			created = true;
			if (!mounted.current) return;
			setProfiles((rows) => [
				...(rows ?? []).filter(
					(entry) => entry.profile.profileId !== row.profile.profileId,
				),
				row,
			]);
			setSelected(row.profile.profileId);
			if (!admittedPage()) throw new Error("browser_controller_changed");
			await session.input(
				{ kind: "profile_set", profile_id: row.profile.profileId },
				page,
			);
			if (mounted.current) setOpen(false);
		} catch {
			if (mounted.current) {
				setFailure(created ? "created" : "request");
				if (created) setMode("choose");
			}
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	const remove = async () => {
		if (
			busy ||
			!admittedPage() ||
			!selectedProfile ||
			selectedProfile.profile.profileId === "default" ||
			selectedProfile.state === "deleted"
		)
			return;
		setBusy(true);
		setFailure(undefined);
		try {
			await session.client.deleteProfile(
				selectedProfile.profile.profileId,
				crypto.randomUUID(),
			);
			if (mounted.current) setOpen(false);
			await onProfileDeleted();
		} catch {
			if (mounted.current) setFailure("request");
		} finally {
			if (mounted.current) setBusy(false);
		}
	};
	const begin = (next: "create" | "delete") => {
		if (!admittedPage() || busy) return;
		setFailure(undefined);
		setMode(next);
		if (next === "create") {
			setName("");
			setNativeUserAgent(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!busy) setOpen(next);
			}}
		>
			<Button
				ref={trigger}
				size="sm"
				variant="ghost"
				disabled={!view.page}
				onClick={() => {
					setMode("choose");
					setOpen(true);
				}}
			>
				{t("panels.browser.profiles")}
			</Button>
			<DialogContent
				className="sm:max-w-md"
				dismiss={busy ? "none" : "all"}
				showCloseButton={!busy}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					trigger.current?.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{t(
							mode === "create"
								? "panels.browser.newProfile"
								: mode === "delete"
									? "panels.browser.deleteProfile"
									: "panels.browser.profiles",
						)}
					</DialogTitle>
					<DialogDescription>
						{mode === "delete"
							? t("panels.browser.deleteProfileHint", {
									name: selectedProfile?.profile.label ?? "",
								})
							: t("panels.browser.profileSwitchHint")}
					</DialogDescription>
				</DialogHeader>
				{failure && (
					<ErrorText>
						{t(
							failure === "created"
								? "panels.browser.profileCreatedSwitchFailed"
								: "ipc.browser.requestFailed",
						)}
					</ErrorText>
				)}
				{mode === "create" ? (
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							void create();
						}}
					>
						<label className="block space-y-2">
							<span>{t("panels.browser.profileName")}</span>
							<Input
								aria-label={t("panels.browser.profileName")}
								value={name}
								disabled={busy}
								onChange={(event) => setName(event.target.value)}
							/>
						</label>
						<div className="flex items-start gap-3">
							<Switch
								id={userAgentId}
								aria-label={t("panels.browser.nativeUserAgent")}
								aria-describedby={`${userAgentId}-hint`}
								checked={nativeUserAgent}
								disabled={busy}
								onCheckedChange={setNativeUserAgent}
							/>
							<div className="space-y-1">
								<label htmlFor={userAgentId}>
									{t("panels.browser.nativeUserAgent")}
								</label>
								<p
									id={`${userAgentId}-hint`}
									className="text-xs text-muted-foreground"
								>
									{t("panels.browser.nativeUserAgentHint")}
								</p>
							</div>
						</div>
						<DialogFooter>
							<ConfirmationButton
								type="button"
								variant="glass"
								disabled={busy}
								onClick={() => {
									setFailure(undefined);
									setMode("choose");
								}}
							>
								{t("common.cancel")}
							</ConfirmationButton>
							<ConfirmationButton
								type="submit"
								disabled={
									!enabled ||
									busy ||
									!!failure ||
									!isBrowserProfileLabel(name.trim())
								}
							>
								{t("panels.browser.createProfileAndSwitch")}
							</ConfirmationButton>
						</DialogFooter>
					</form>
				) : mode === "delete" ? (
					<DialogFooter>
						<ConfirmationButton
							variant="glass"
							disabled={busy}
							onClick={() => {
								setFailure(undefined);
								setMode("choose");
							}}
						>
							{t("common.cancel")}
						</ConfirmationButton>
						<ConfirmationButton
							variant="destructive"
							disabled={!enabled || busy || !!failure}
							onClick={() => void remove()}
						>
							{t("panels.browser.confirmDeleteProfile")}
						</ConfirmationButton>
					</DialogFooter>
				) : (
					<>
						<SelectField
							aria-label={t("panels.browser.profileDestination")}
							value={selected}
							disabled={busy || !profiles}
							onValueChange={(nextValue) => setSelected(nextValue)}
						>
							<SelectOption value="">
								{t(profiles ? "panels.browser.chooseProfile" : "common.loading")}
							</SelectOption>
							{profiles
								?.filter((row) => row.state !== "deleted")
								.map(({ profile, state }) => (
									<SelectOption key={profile.profileId} value={profile.profileId}>
										{state === "retiring"
											? t("panels.browser.profileRetiring", {
													name: profile.label,
												})
											: profile.label}
									</SelectOption>
								))}
						</SelectField>
						<div className="flex justify-between gap-2">
							<Button
								variant="ghost"
								disabled={!enabled || busy || !!failure}
								onClick={() => begin("create")}
							>
								{t("panels.browser.newProfile")}
							</Button>
							<Button
								variant="ghost"
								disabled={
									!enabled ||
									busy ||
									!!failure ||
									!selectedProfile ||
									selected === "default"
								}
								onClick={() => begin("delete")}
							>
								{t("panels.browser.deleteProfile")}
							</Button>
						</div>
						<p className="text-xs text-muted-foreground">
							{t("panels.browser.profileCloneHint")}
						</p>
						<DialogFooter>
							<ConfirmationButton
								variant="glass"
								disabled={
									!enabled ||
									busy ||
									selectedProfile?.state !== "active" ||
									!!failure
								}
								onClick={() => void change("profile_clone")}
							>
								{t("panels.browser.profileClone")}
							</ConfirmationButton>
							<ConfirmationButton
								disabled={
									!enabled ||
									busy ||
									selectedProfile?.state !== "active" ||
									selected === currentProfile ||
									!!failure
								}
								onClick={() => void change("profile_set")}
							>
								{t("panels.browser.profileSwitch")}
							</ConfirmationButton>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
