import type { IDockviewPanelProps } from "dockview-react";
import {
	ArrowLeft,
	Camera,
	ExternalLink,
	Home,
	Play,
	Smartphone,
	Square,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoadingStatus, PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Textarea } from "@/components/ui/textarea";
import { usePaneActions } from "@/components/workspace/usePaneActions";
import { useWorkspaceRuntimeActive } from "@/components/workspace/WorkspaceRuntimeContext";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { t } from "@/lib/i18n";
import {
	type MobileDeviceAction,
	type MobileDeviceCatalog,
	type MobileDeviceTarget,
	type MobileFrame,
	mobileSimulator,
} from "@/lib/ipc/mobileSimulator";
import { saveTempImage } from "@/lib/ipc/system";
import { mobilePaneActions } from "@/lib/mobileSimulator/actions";
import type {
	MobilePreviewMode,
	MobileReportControls,
} from "@/lib/mobileSimulator/controlActions";
import { MobileLiveObserver } from "@/lib/mobileSimulator/live";
import {
	mobileFramebufferGesture,
	presentMobileFrame,
} from "@/lib/mobileSimulator/presentation";
import {
	MobileFrameObserver,
	mobileDeviceKey,
	mobileFramePoint,
	readMobileDeviceTarget,
} from "@/lib/mobileSimulator/preview";
import {
	type MobileRunProfile,
	readMobileRunProfiles,
	saveMobileRunProfile,
} from "@/lib/mobileSimulator/profile";
import type { PaneActionEntry } from "@/lib/workspace/pane/paneActionRegistry";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import { usePaneAgentChoices } from "../usePaneAgentChoices";
import { MobileSimulatorAppForm } from "./MobileSimulatorAppForm";
import { MobileSimulatorCaptureButton } from "./MobileSimulatorCaptureButton";
import { MobileSimulatorProfiles } from "./MobileSimulatorProfiles";
import { MobileSimulatorReport } from "./MobileSimulatorReport";

export function MobileSimulatorPanel(
	props: IDockviewPanelProps<{
		device?: MobileDeviceTarget;
		profiles?: MobileRunProfile[];
		iosLandscape?: boolean;
	}>,
) {
	const agents = usePaneAgentChoices();
	const reportControls = useRef<MobileReportControls>(null);
	const [profiles, setProfiles] = useState(() =>
		readMobileRunProfiles(props.params.profiles),
	);
	const [buildOutput, setBuildOutput] = useState("");
	const [inputText, setInputText] = useState("");
	const [catalog, setCatalog] = useState<MobileDeviceCatalog>();
	const [target, setTarget] = useState(() =>
		readMobileDeviceTarget(props.params.device),
	);
	const [iosLandscape, setIosLandscape] = useState(
		props.params.iosLandscape === true,
	);
	const [visible, setVisible] = useState(props.api.isVisible);
	const workspaceActive = useWorkspaceRuntimeActive();
	const [documentVisible, setDocumentVisible] = useState(!document.hidden);
	const active = visible && workspaceActive && documentVisible;
	const [loading, setLoading] = useState(false);
	const [operationBusy, setBusy] = useState(false);
	const [reportBusy, setReportBusy] = useState(false);
	const busy = operationBusy || reportBusy;
	const [error, setError] = useState<string>();
	const [captured, setCaptured] = useState<{
		key: string;
		frame: MobileFrame;
	}>();
	const [observer] = useState(
		() => new MobileFrameObserver(mobileSimulator.capture),
	);
	const [live, setLive] = useState(false);
	const [liveObserver] = useState(
		() => new MobileLiveObserver(mobileSimulator),
	);
	const [autoRefresh, setAutoRefresh] = useState(false);
	const [revision, setRevision] = useState(0);
	const [url, setUrl] = useState("");
	const selection = target ? mobileDeviceKey(target) : "";
	const projection = useMemo(
		() => ({
			key: selection,
			active,
			landscape: target?.platform === "ios" && iosLandscape,
		}),
		[selection, target?.platform, iosLandscape, active],
	);
	const currentProjection = useRef(projection);
	currentProjection.current = projection;
	const frame = captured?.key === selection ? captured.frame : undefined;
	const selected = catalog?.devices.find(
		(device) => mobileDeviceKey(device) === selection,
	);
	const ready = selected?.state === "ready";
	const currentFrame = useRef(frame);
	currentFrame.current = frame;
	const mounted = useRef(true);
	async function publishFrame(raw: MobileFrame) {
		const view = currentProjection.current;
		if (view.key !== selection || !view.active) return;
		const frame = await presentMobileFrame(raw, view.landscape);
		if (mounted.current && currentProjection.current === view)
			setCaptured({ key: selection, frame });
	}
	async function captureDisplay() {
		if (!target) throw new Error("No device selected");
		return presentMobileFrame(
			await mobileSimulator.capture(target),
			projection.landscape,
		);
	}
	const gesture = useRef<{
		start: NonNullable<ReturnType<typeof mobileFramePoint>>;
		width: number;
		height: number;
		key: string;
	} | null>(null);
	const operation = useRef(false);
	const listGeneration = useRef(0);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			listGeneration.current++;
		};
	}, []);
	useEffect(() => {
		const changed = () => setDocumentVisible(!document.hidden);
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);
	useEffect(() => {
		const listener = props.api.onDidVisibilityChange(() =>
			setVisible(props.api.isVisible),
		);
		return () => listener.dispose();
	}, [props.api]);

	async function refreshDevices() {
		const generation = ++listGeneration.current;
		setLoading(true);
		setError(undefined);
		try {
			const next = await mobileSimulator.list();
			if (mounted.current && generation === listGeneration.current)
				setCatalog(next);
			return next;
		} catch (cause) {
			if (mounted.current && generation === listGeneration.current)
				setError(String(cause));
			throw cause;
		} finally {
			if (mounted.current && generation === listGeneration.current)
				setLoading(false);
		}
	}

	useEffect(() => {
		if (active) void refreshDevices().catch(() => {});
	}, [active]);
	useEffect(() => {
		applyAutomaticPaneTitle(
			props.api,
			selected?.name ?? t("panels.mobile.title"),
		);
	}, [props.api, selected?.name]);
	useEffect(() => {
		setCaptured(undefined);
		gesture.current = null;
		if (!active || !target || !ready || busy || live) return;
		return observer.observe({
			target,
			repeat: autoRefresh,
			publish: publishFrame,
			fail: (cause) => {
				setError(String(cause));
			},
		});
	}, [target, active, ready, busy, autoRefresh, revision, live, iosLandscape]);
	useEffect(() => {
		if (!live || !active || !target || !ready) return;
		return liveObserver.observe({
			target,
			publish: publishFrame,
			fail: (error) => {
				setError(String(error));
				setLive(false);
			},
		});
	}, [live, active, target, ready]);

	function isOperating() {
		return operation.current || reportControls.current?.busy() === true;
	}
	async function act(action: MobileDeviceAction) {
		if (!target || isOperating()) return false;
		operation.current = true;
		setBusy(true);
		setError(undefined);
		try {
			let nativeAction = action;
			if (target.platform === "ios" && action.kind === "gesture") {
				const mapped = mobileFramebufferGesture(
					action,
					currentFrame.current,
					iosLandscape,
				);
				if (!mapped) throw new Error(t("panels.mobile.orientationChanged"));
				nativeAction = mapped;
			}
			await mobileSimulator.act(target, nativeAction);
			if (
				mounted.current &&
				target.platform === "ios" &&
				action.kind === "rotate"
			) {
				setIosLandscape(action.landscape);
				props.api.updateParameters({ iosLandscape: action.landscape });
			}
			if (mounted.current) await refreshDevices();
			return true;
		} catch (cause) {
			if (mounted.current) {
				await refreshDevices().catch(() => {});
				if (mounted.current) setError(String(cause));
			}
			return false;
		} finally {
			operation.current = false;
			if (mounted.current) {
				setBusy(false);
				setRevision((value) => value + 1);
			}
		}
	}

	async function runProfile(profile: MobileRunProfile) {
		if (isOperating() || !target) return;
		operation.current = true;
		setBusy(true);
		setError(undefined);
		setBuildOutput("");
		try {
			const result = await mobileSimulator.run(target, profile);
			if (mounted.current) {
				setBuildOutput(result.buildOutput);
				await refreshDevices();
			}
		} catch (cause) {
			if (mounted.current) {
				await refreshDevices().catch(() => {});
				if (mounted.current) setError(String(cause));
			}
		} finally {
			operation.current = false;
			if (mounted.current) {
				setBusy(false);
				setRevision((value) => value + 1);
			}
		}
	}
	function chooseTarget(next: MobileDeviceTarget | null) {
		if (isOperating()) return;
		setTarget(next);
		setError(undefined);
		setAutoRefresh(false);
		setLive(false);
		const preserveAngle =
			next && target && mobileDeviceKey(next) === mobileDeviceKey(target);
		if (!preserveAngle) setIosLandscape(false);
		props.api.updateParameters({
			device: next,
			iosLandscape: Boolean(preserveAngle && iosLandscape),
		});
	}
	function saveProfile(profile: MobileRunProfile) {
		const next = saveMobileRunProfile(profiles, profile);
		setProfiles(next);
		props.api.updateParameters({ profiles: next });
	}
	function removeProfile(projectPath: string) {
		const next = profiles.filter(
			(profile) => profile.projectPath !== projectPath,
		);
		setProfiles(next);
		props.api.updateParameters({ profiles: next });
	}
	function preview(mode: MobilePreviewMode) {
		if (isOperating()) throw new Error(t("panels.mobile.working"));
		if (mode !== "snapshot" && (!ready || !active))
			throw new Error(t("panels.mobile.previewUnavailable"));
		if (mode === "live" && target?.platform !== "ios")
			throw new Error(t("panels.mobile.liveRequiresIos"));
		setError(undefined);
		setAutoRefresh(mode === "auto");
		setLive(mode === "live");
	}
	const paneActions = useMemo<PaneActionEntry>(
		() => ({
			paneId: props.api.id,
			status: busy ? "turn_active" : error ? "error" : "idle",
			error,
			context: JSON.stringify({ device: target }),
			actions: mobilePaneActions({
				target,
				profiles,
				isBusy: isOperating,
				status: () => ({
					device: target,
					busy: isOperating(),
					live,
					error,
					buildOutput,
					profiles,
					deviceState: selected?.state,
					preview: {
						viewingAngle: projection.landscape ? "landscape" : "portrait",
						mode: live ? "live" : autoRefresh ? "auto" : "snapshot",
						active,
						frameReady: Boolean(currentFrame.current),
						liveFrameReady: Boolean(
							live &&
								currentFrame.current?.dataUrl.startsWith("data:image/jpeg"),
						),
					},
				}),
				controls: {
					devices: refreshDevices,
					select: chooseTarget,
					preview,
					save: saveProfile,
					remove: removeProfile,
					report: () => reportControls.current,
					agents: () =>
						agents.map((agent) => ({
							id: agent.id,
							name: agentDisplayName(agent),
						})),
				},
				act,
				run: runProfile,
				capture: async () => {
					if (!target) throw new Error("No device selected");
					const frame = await captureDisplay();
					if (mounted.current && !live)
						setCaptured({ key: mobileDeviceKey(target), frame });
					return {
						path: await saveTempImage({
							dataB64: frame.dataUrl.split(",")[1],
							ext: "png",
						}),
						width: frame.width,
						height: frame.height,
					};
				},
				report: async (appId) => {
					if (!target) throw new Error("No device selected");
					return mobileSimulator.report(target, appId);
				},
			}),
		}),
		[
			props.api.id,
			target,
			profiles,
			busy,
			error,
			buildOutput,
			live,
			autoRefresh,
			active,
			selected?.state,
			agents,
			projection,
		],
	);
	usePaneActions(`${props.api.id}:${selection}`, paneActions);

	function select(key: string) {
		const device = catalog?.devices.find(
			(candidate) => mobileDeviceKey(candidate) === key,
		);
		const next = device ? { platform: device.platform, id: device.id } : null;
		chooseTarget(next);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex shrink-0 items-center gap-1 border-b p-2">
				<SelectField
					value={selection}
					onValueChange={select}
					disabled={busy}
					aria-label={t("panels.mobile.chooseDevice")}
					className="h-7 min-w-0 flex-1"
					display={selected?.name ?? t("panels.mobile.chooseDevice")}
				>
					<SelectOption value="">
						{t("panels.mobile.chooseDevice")}
					</SelectOption>
					{catalog?.devices.map((device) => (
						<SelectOption
							key={mobileDeviceKey(device)}
							value={mobileDeviceKey(device)}
						>
							{device.name} · {device.runtime} ·{" "}
							{t(`panels.mobile.state.${device.state}`)}
						</SelectOption>
					))}
				</SelectField>
				<RefreshButton
					disabled={loading || busy}
					busy={loading}
					title={t("panels.mobile.refreshDevices")}
					onClick={() => void refreshDevices().catch(() => {})}
				/>
			</div>
			{selected && (
				<div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1">
					<span className="mr-auto text-xs text-muted-foreground">
						{selected.runtime} · {t(`panels.mobile.state.${selected.state}`)}
					</span>
					{selected.platform === "ios" && (
						<>
							{!ready && (
								<Button
									size="sm"
									variant="outline"
									disabled={busy || selected.state !== "shutdown"}
									onClick={() => void act({ kind: "boot" })}
								>
									<Play />
									{t("panels.mobile.boot")}
								</Button>
							)}
							<IconButton
								title={t("panels.mobile.openNative")}
								disabled={busy || !ready}
								onClick={() => void act({ kind: "open_native" })}
							>
								<ExternalLink />
							</IconButton>
						</>
					)}
					{(selected.platform === "android" || live) &&
						(
							[
								["back", ArrowLeft],
								["home", Home],
								["recents", Square],
							] as const
						)
							.filter(
								([button]) =>
									selected.platform === "android" || button === "home",
							)
							.map(([button, Icon]) => (
								<IconButton
									key={button}
									title={t(`panels.mobile.${button}`)}
									disabled={!ready || busy}
									onClick={() => void act({ kind: "button", button })}
								>
									<Icon />
								</IconButton>
							))}
					<IconButton
						title={t("panels.mobile.capture")}
						disabled={!ready || busy}
						onClick={() => {
							setError(undefined);
							setRevision((value) => value + 1);
						}}
					>
						<Camera />
					</IconButton>
					<MobileSimulatorCaptureButton frame={frame} paneId={props.api.id} />
					{selected.platform === "ios" && (
						<label className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
							<input
								type="checkbox"
								checked={live}
								disabled={!ready || busy}
								onChange={(event) => {
									preview(event.target.checked ? "live" : "snapshot");
								}}
							/>
							{t("panels.mobile.live")}
						</label>
					)}
					<label className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
						<input
							type="checkbox"
							checked={autoRefresh}
							disabled={!ready || busy || live}
							onChange={(event) => {
								preview(event.target.checked ? "auto" : "snapshot");
							}}
						/>
						{t("panels.mobile.autoRefresh")}
					</label>
				</div>
			)}
			{error && (
				<div
					role="alert"
					className="shrink-0 break-words border-b px-3 py-2 text-xs text-destructive"
				>
					{error}
				</div>
			)}
			<div className="max-h-[45%] shrink-0 overflow-y-auto">
				{target && (
					<MobileSimulatorProfiles
						profiles={profiles}
						target={target}
						busy={busy}
						select={chooseTarget}
						run={runProfile}
						save={saveProfile}
						remove={removeProfile}
					/>
				)}
				{buildOutput && (
					<details className="shrink-0 border-b px-3 py-2 text-xs">
						<summary>{t("panels.mobile.buildOutput")}</summary>
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap">
							{buildOutput}
						</pre>
					</details>
				)}
				{selected && ready && (
					<>
						<form
							className="flex shrink-0 gap-1 border-b p-2"
							onSubmit={(event) => {
								event.preventDefault();
								void act({ kind: "open_url", url });
							}}
						>
							<Input
								aria-label={t("panels.mobile.url")}
								placeholder={t("panels.mobile.url")}
								value={url}
								onChange={(event) => setUrl(event.target.value)}
								className="h-7 min-w-0"
								disabled={busy}
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={busy || !url.trim()}
							>
								{t("panels.mobile.open")}
							</Button>
						</form>
						{(selected.platform === "android" || live) && (
							<form
								className={
									selected.platform === "ios"
										? "flex shrink-0 flex-wrap items-start gap-1 border-b p-2"
										: "flex shrink-0 gap-1 border-b p-2"
								}
								onSubmit={(event) => {
									event.preventDefault();
									void act({ kind: "type", text: inputText });
								}}
							>
								{selected.platform === "ios" ? (
									<Textarea
										value={inputText}
										aria-label={t("panels.mobile.pasteText")}
										placeholder={t("panels.mobile.pasteText")}
										disabled={busy}
										onChange={(event) => setInputText(event.target.value)}
										rows={2}
										className="min-w-0 basis-full"
									/>
								) : (
									<Input
										value={inputText}
										aria-label={t("panels.mobile.inputText")}
										placeholder={t("panels.mobile.inputText")}
										disabled={busy}
										onChange={(event) => setInputText(event.target.value)}
									/>
								)}
								{selected.platform === "ios" && (
									<Button
										type="button"
										size="sm"
										disabled={busy || !inputText}
										onClick={() => void act({ kind: "paste", text: inputText })}
									>
										{t("panels.mobile.paste")}
									</Button>
								)}
								<Button size="sm" disabled={busy || !inputText}>
									{t("panels.mobile.type")}
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy || !frame}
									onClick={() =>
										void act({
											kind: "rotate",
											landscape: Boolean(frame && frame.width < frame.height),
										})
									}
								>
									{t("panels.mobile.rotate")}
								</Button>
							</form>
						)}
						<MobileSimulatorReport
							key={selection}
							ref={reportControls}
							target={selected}
							busy={operationBusy}
							onWorkingChange={setReportBusy}
							capture={captureDisplay}
						/>
						<MobileSimulatorAppForm
							platform={selected.platform}
							busy={busy}
							act={async (action) => {
								await act(action);
							}}
						/>
					</>
				)}
			</div>
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 p-3">
				{busy && !live ? (
					<LoadingStatus label={t("panels.mobile.working")} />
				) : frame ? (
					<img
						src={frame.dataUrl}
						alt={t("panels.mobile.screen", { name: selected?.name ?? "" })}
						className="max-h-full max-w-full select-none rounded-lg object-contain"
						draggable={false}
						style={{
							touchAction:
								selected?.platform === "android" || live ? "none" : "auto",
						}}
						onPointerDown={(event) => {
							if (
								(selected?.platform !== "android" && !live) ||
								busy ||
								event.button !== 0
							)
								return;
							const start = mobileFramePoint(
								event.currentTarget.getBoundingClientRect(),
								event.clientX,
								event.clientY,
							);
							gesture.current = start
								? {
										start,
										width: frame.width,
										height: frame.height,
										key: selection,
									}
								: null;
							event.currentTarget.setPointerCapture(event.pointerId);
						}}
						onPointerCancel={() => {
							gesture.current = null;
						}}
						onPointerUp={(event) => {
							const down = gesture.current;
							gesture.current = null;
							const end = mobileFramePoint(
								event.currentTarget.getBoundingClientRect(),
								event.clientX,
								event.clientY,
							);
							if (down && end && down.key === selection)
								void act({
									kind: "gesture",
									start: down.start,
									end,
									width: down.width,
									height: down.height,
								});
						}}
					/>
				) : loading ? (
					<LoadingStatus />
				) : (
					<PanelStatus size="xs" className="max-w-80 text-center">
						<Smartphone className="mb-2 size-8 opacity-40" />
						<p>
							{target && !selected
								? t("panels.mobile.deviceGone")
								: selected
									? t(
											ready
												? "panels.mobile.captureHint"
												: "panels.mobile.startHint",
										)
									: t("panels.mobile.empty")}
						</p>
						{!catalog?.devices.length && <p>{t("panels.mobile.setup")}</p>}
					</PanelStatus>
				)}
			</div>
			{selected?.platform === "ios" && !live && (
				<p className="shrink-0 px-3 py-2 text-xs text-muted-foreground">
					{t("panels.mobile.iosInput")}
				</p>
			)}
			{catalog?.unavailable.map(({ platform, detail }) => (
				<details
					key={platform}
					className="shrink-0 px-3 py-1 text-xs text-muted-foreground"
				>
					<summary>
						{t(
							platform === "ios"
								? "panels.mobile.iosSetup"
								: "panels.mobile.androidSetup",
						)}
					</summary>
					<p className="break-words py-1">{detail}</p>
				</details>
			))}
		</div>
	);
}
