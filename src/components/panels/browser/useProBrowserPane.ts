import type { IDockviewPanelProps } from "dockview-react";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { usePaneFirstReveal } from "@/components/workspace/usePaneFirstReveal";
import { useWorkspaceRuntimeActive } from "@/components/workspace/WorkspaceRuntimeContext";
import {
	type BrowserPaneBinding,
	type BrowserPaneCreation,
	readBrowserPaneBinding,
	sameBrowserPaneBinding,
	sameBrowserPaneCreation,
} from "@/lib/browser/browserPaneBinding";
import {
	BrowserPaneSession,
	type BrowserPaneView,
} from "@/lib/browser/browserPaneSession";
import {
	type BrowserControllerLease,
	type BrowserControlProjection,
	sameBrowserPage,
	sameBrowserResource,
} from "@/lib/browser/browserResourceContract";
import { t } from "@/lib/i18n";
import {
	assertDureBackendRouteAuthority,
	DureBackendRequestError,
	resolveSelectedDureBackendRouteAuthority,
} from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	sameDureBackendRouteAuthority,
	sameDureBackendRouteTarget,
} from "@/lib/ipc/dureBackendRoute";
import {
	createDureBrowserClient,
	isUnstartedBrowserCreation,
} from "@/lib/ipc/dureBrowser";
import { showToast } from "@/lib/toast";

type Connection = {
	authority: DureBackendRouteAuthorityV1;
	client: ReturnType<typeof createDureBrowserClient>;
};
const EMPTY_VIEW: BrowserPaneView = {};
const emptyRead = () => EMPTY_VIEW;
const emptySubscribe = () => () => {};

export function useProBrowserPane(
	props: IDockviewPanelProps<{
		url: string;
		browserBinding?: unknown;
		browserCreation?: unknown;
	}>,
) {
	const revealed = usePaneFirstReveal(props.api);
	const workspaceActive = useWorkspaceRuntimeActive();
	const [visible, setVisible] = useState(props.api.isVisible);
	const active = useRef(visible && workspaceActive);
	active.current = visible && workspaceActive;
	const [controllerId] = useState(() => `view:${crypto.randomUUID()}`);
	const [connection, setConnection] = useState<Connection>();
	const recoveredAuthority = useRef<DureBackendRouteAuthorityV1 | undefined>(
		undefined,
	);
	const [resources, setResources] = useState<BrowserControlProjection[]>([]);
	const [session, setSession] = useState<BrowserPaneSession>();
	const [busy, setBusy] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<unknown>();
	const selection = useRef(0);
	const operation = useRef(0);
	const [restored] = useState(() => readBrowserPaneBinding(props.params));
	// An exact resource binding can be inspected before its Space is revealed.
	// Empty panes and pending creates still wait for the user's first reveal.
	const [bindingRequested, setBindingRequested] = useState(
		!!restored.binding?.resource && !restored.creation,
	);
	const connectionRequested = revealed || bindingRequested;
	const bindingError = useRef(restored.error);
	const receivedParameters = useRef({
		binding: props.params.browserBinding,
		creation: props.params.browserCreation,
	});
	const savedBinding = useRef(restored.binding);
	const creation = useRef(restored.creation);
	const view = useSyncExternalStore(
		session?.subscribe ?? emptySubscribe,
		session?.read ?? emptyRead,
		emptyRead,
	);

	const persist = useCallback(
		(binding: BrowserPaneBinding | undefined, pending = creation.current) => {
			savedBinding.current = binding;
			creation.current = pending;
			props.api.updateParameters({
				browserBinding: binding,
				browserCreation: pending,
			});
		},
		[props.api],
	);
	const createResource = useCallback(
		async (
			connection: Connection,
			pending: BrowserPaneCreation,
			current: () => boolean,
		) => {
			try {
				// A legacy scoped operation must retain its original journal identity.
				// Recover its receipt without issuing a differently scoped Create.
				return pending.workspaceId === null
					? await connection.client.create(pending.operationId)
					: await connection.client.recoverCreation(pending.operationId);
			} catch (error) {
				if (
					current() &&
					creation.current === pending &&
					isUnstartedBrowserCreation(error)
				) {
					creation.current = undefined;
					const binding = savedBinding.current;
					persist(
						binding &&
							sameDureBackendRouteAuthority(
								binding.authority,
								pending.authority,
							)
							? binding
							: pending.workspaceId
								? {
										authority: pending.authority,
										workspaceId: pending.workspaceId,
									}
								: undefined,
					);
				}
				throw error;
			}
		},
		[persist],
	);
	const selectedPageId = view.selectedPageId;
	const followingCurrent = view.followingCurrent;
	useEffect(() => {
		const saved = savedBinding.current;
		if (
			!session ||
			!connection ||
			followingCurrent === undefined ||
			!saved?.resource ||
			!sameBrowserResource(saved.resource, session.resource) ||
			!sameDureBackendRouteAuthority(saved.authority, connection.authority) ||
			(saved.pageId === selectedPageId &&
				saved.followCurrent === followingCurrent)
		)
			return;
		persist({
			...saved,
			pageId: selectedPageId,
			followCurrent: followingCurrent,
		});
	}, [selectedPageId, followingCurrent, session, connection, persist]);
	const run = useCallback(
		async (action: (current: () => boolean) => Promise<unknown>) => {
			const ticket = selection.current;
			const job = ++operation.current;
			const current = () => ticket === selection.current;
			setBusy(true);
			setError(undefined);
			try {
				await action(current);
			} catch (caught) {
				if (current() && job === operation.current) setError(caught);
			} finally {
				if (current() && job === operation.current) setBusy(false);
			}
		},
		[],
	);
	const connect = useCallback(
		async (releasePreviousInputs = false) => {
			++selection.current;
			setInstalling(false);
			setSession(undefined);
			setConnection(undefined);
			setResources([]);
			await run(async (current) => {
				if (bindingError.current) throw bindingError.current;
				let binding = savedBinding.current;
				const pending = creation.current;
				const savedRoute = pending?.authority ?? binding?.authority;
				let authority: DureBackendRouteAuthorityV1;
				try {
					authority = savedRoute
						? await assertDureBackendRouteAuthority(savedRoute)
						: await resolveSelectedDureBackendRouteAuthority(undefined);
				} catch (caught) {
					if (
						pending ||
						!binding ||
						!savedRoute ||
						!(caught instanceof DureBackendRequestError) ||
						caught.failure.kind !== "authority_changed"
					)
						throw caught;
					// Refresh only this profile's passive view. An uncertain mutation
					// keeps its original route; no input or creation crosses generations.
					authority = await resolveSelectedDureBackendRouteAuthority(
						savedRoute.profileId,
					);
					if (
						authority.backend.id !== savedRoute.backend.id ||
						!sameDureBackendRouteTarget(authority.target, savedRoute.target)
					)
						throw caught;
					binding =
						authority.backend.generation === savedRoute.backend.generation
							? { ...binding, authority }
							: { authority, workspaceId: binding.workspaceId };
				}
				if (!current()) return;
				const rebound = binding !== savedBinding.current;
				let resource = pending ? undefined : binding?.resource;
				const client = createDureBrowserClient(authority);
				let resources = await client.list();
				if (!current()) return;
				setConnection({ authority, client });
				if (pending) {
					const created = await createResource(
						{ authority, client },
						pending,
						current,
					);
					if (!current()) return;
					resource = created.resource;
					resources = [
						...resources.filter(
							(row) => !sameBrowserResource(row.resource, resource!),
						),
						created,
					];
					creation.current = undefined;
					binding = { authority, workspaceId: resource.workspace_id, resource };
					persist(binding);
				}
				setResources(resources);
				if (
					resource &&
					!resources.some((row) => sameBrowserResource(row.resource, resource!))
				)
					throw new Error("browser_saved_resource_missing");
				if (resource) {
					const attached = new BrowserPaneSession(
						client,
						resource,
						controllerId,
						pending || binding?.followCurrent ? undefined : binding?.pageId,
					);
					if (releasePreviousInputs || !active.current) {
						// Populate the binding and control once without starting the
						// hidden viewer's continuous frame capture.
						await attached.refresh({ capture: active.current });
						// A surviving browser can still hold this view's keys across a
						// route revision. Release only freshly observed contacts under
						// the same controller lease; never replay the failed input.
						if (current() && releasePreviousInputs) await attached.release();
						if (!current()) {
							void attached.dispose(false);
							return;
						}
					}
					setSession(attached);
				}
				if (rebound && current()) persist(binding);
			});
		},
		[controllerId, persist, run, createResource],
	);

	useEffect(() => {
		if (
			!session ||
			!connection ||
			busy ||
			view.submitting ||
			creation.current ||
			![error, view.error].some(
				(failure) =>
					failure instanceof DureBackendRequestError &&
					failure.failure.kind === "authority_changed",
			) ||
			(recoveredAuthority.current &&
				sameDureBackendRouteAuthority(
					recoveredAuthority.current,
					connection.authority,
				))
		)
			return;
		// Retry passive attachment once per obsolete authority. The existing
		// reconnect path fences backend identity and pending Create receipts.
		recoveredAuthority.current = connection.authority;
		// This route already rejected our authority; cleanup must not send held
		// input releases through it or produce a second stale-route notification.
		void session.dispose(false);
		void connect(true);
	}, [session, connection, busy, error, view.error, view.submitting, connect]);

	useEffect(() => {
		if (connectionRequested) void connect();
		return () => {
			selection.current++;
		};
	}, [connectionRequested, connect]);
	useEffect(() => {
		const previous = receivedParameters.current;
		if (
			previous.binding === props.params.browserBinding &&
			previous.creation === props.params.browserCreation
		)
			return;
		receivedParameters.current = {
			binding: props.params.browserBinding,
			creation: props.params.browserCreation,
		};
		const incoming = readBrowserPaneBinding(props.params);
		if (
			!incoming.error &&
			!bindingError.current &&
			sameBrowserPaneBinding(incoming.binding, savedBinding.current) &&
			sameBrowserPaneCreation(incoming.creation, creation.current)
		)
			return;
		bindingError.current = incoming.error;
		if (!incoming.error) {
			savedBinding.current = incoming.binding;
			creation.current = incoming.creation;
		}
		const binding = incoming.binding;
		if (
			!incoming.error &&
			!incoming.creation &&
			binding?.resource &&
			session &&
			connection &&
			sameBrowserResource(binding.resource, session.resource) &&
			sameDureBackendRouteAuthority(binding.authority, connection.authority)
		) {
			// A presentation request changes only this viewer. Host selection and
			// control continue to come from the existing session's observations.
			setError(undefined);
			session.selectPage(binding.followCurrent ? undefined : binding.pageId);
			void session.refresh({ capture: active.current });
		} else if (connectionRequested) void connect();
		else if (binding?.resource && !incoming.creation) setBindingRequested(true);
	}, [
		props.params.browserBinding,
		props.params.browserCreation,
		session,
		connection,
		connectionRequested,
		connect,
	]);
	useEffect(() => {
		const subscription = props.api.onDidVisibilityChange(() =>
			setVisible(props.api.isVisible),
		);
		return () => subscription.dispose();
	}, [props.api]);
	useEffect(
		() => () => {
			if (session)
				void session.dispose().catch(() =>
					showToast(t("panels.browser.releaseFailed"), {
						ms: 5000,
						paneId: props.api.id,
					}),
				);
		},
		[session],
	);
	useEffect(() => {
		if (!session) return;
		if (!visible || !workspaceActive) {
			void session.release().catch(() =>
				showToast(t("panels.browser.releaseFailed"), {
					ms: 5000,
					paneId: props.api.id,
				}),
			);
			return;
		}
		let stopped = false;
		let paint: number | undefined;
		let finishPaint: (() => void) | undefined;
		let ticking = false;
		const documentVisible = () => document.visibilityState !== "hidden";
		const tick = async () => {
			if (stopped || ticking || !documentVisible()) return;
			ticking = true;
			// Capture and display cadence advance together. Waiting for a paint
			// only after capture adds an idle frame to every remote image.
			const painted = new Promise<void>((resolve) => {
				finishPaint = resolve;
				paint = requestAnimationFrame(() => {
					paint = undefined;
					finishPaint = undefined;
					resolve();
				});
			});
			await Promise.all([session.refresh(), painted]);
			ticking = false;
			if (!stopped && documentVisible()) void tick();
		};
		const visibility = () => {
			if (paint !== undefined) cancelAnimationFrame(paint);
			paint = undefined;
			finishPaint?.();
			finishPaint = undefined;
			if (document.visibilityState === "hidden")
				void session.release().catch(() =>
					showToast(t("panels.browser.releaseFailed"), {
						ms: 5000,
						paneId: props.api.id,
					}),
				);
			void tick();
		};
		void tick();
		document.addEventListener("visibilitychange", visibility);
		return () => {
			stopped = true;
			if (paint !== undefined) cancelAnimationFrame(paint);
			finishPaint?.();
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [session, visible, workspaceActive]);

	const attach = (resource: BrowserControlProjection) => {
		if (!connection) return;
		const attached = new BrowserPaneSession(
			connection.client,
			resource.resource,
			controllerId,
		);
		setSession(attached);
		persist({
			authority: connection.authority,
			resource: attached.resource,
			workspaceId: attached.resource.workspace_id,
		});
		return attached;
	};
	const create = async (current: () => boolean) => {
		if (!connection) return;
		const pending = creation.current;
		if (
			pending &&
			!sameDureBackendRouteAuthority(pending.authority, connection.authority)
		)
			throw new Error("browser_creation_route_changed");
		const operationId = pending?.operationId ?? crypto.randomUUID();
		creation.current = pending ?? {
			authority: connection.authority,
			workspaceId: null,
			operationId,
		};
		persist(savedBinding.current);
		const created = await createResource(connection, creation.current, current);
		if (!current()) return;
		setResources((rows) => [
			...rows.filter(
				(row) => row.resource.resource_id !== created.resource.resource_id,
			),
			created,
		]);
		creation.current = undefined;
		return attach(created);
	};
	const renderedSelection = selection.current;
	return {
		active: visible && workspaceActive,
		connected: !!connection,
		view,
		session,
		busy,
		installing,
		installRuntime: () =>
			run(async (current) => {
				if (!connection) return;
				setInstalling(true);
				try {
					let status = await connection.client.runtimeInstallation(true);
					const deadline = Date.now() + 12 * 60_000;
					while (current() && status !== "ready") {
						if (Date.now() >= deadline)
							throw new DureBackendRequestError(
								"browser_installation_timeout",
								"Browser installation timed out",
								{ kind: "operation", disposition: "terminal" },
							);
						await new Promise((resolve) => setTimeout(resolve, 1500));
						if (!current()) return;
						status = await connection.client.runtimeInstallation();
					}
					if (current()) await create(current);
				} finally {
					if (current()) setInstalling(false);
				}
			}),
		error,
		controllerId,
		resources,
		refreshAfterProfileDeletion: async () => {
			if (renderedSelection !== selection.current || !session || !connection)
				return;
			await run(async (current) => {
				const previous = session.read();
				setSession(undefined);
				await session.dispose(false);
				if (!current()) return;
				const rows = await connection.client.list();
				if (!current()) return;
				setResources(rows);
				const surviving = rows.find((row) =>
					sameBrowserResource(row.resource, session.resource),
				);
				persist({
					authority: connection.authority,
					workspaceId: session.resource.workspace_id,
					...(surviving
						? {
								resource: surviving.resource,
								pageId: previous.selectedPageId,
								followCurrent: previous.followingCurrent,
							}
						: {}),
				});
				if (surviving)
					setSession(
						new BrowserPaneSession(
							connection.client,
							surviving.resource,
							controllerId,
							previous.followingCurrent ? undefined : previous.selectedPageId,
						),
					);
			});
		},
		reconnect: () => {
			recoveredAuthority.current = undefined;
			void connect();
		},
		run,
		attach: (id: string) => {
			const resource = resources.find((row) => row.resource.resource_id === id);
			if (resource) {
				++selection.current;
				setBusy(false);
				setError(undefined);
				attach(resource);
			}
		},
		selectPage: (id: string) => {
			if (!session) return;
			const page = session
				.read()
				.observation?.pages.find((row) => row.page.page_id === id)?.page;
			session.selectPage(id || undefined);
			const control = session.read().control;
			if (
				page &&
				control?.controller?.controller_id === controllerId &&
				control.phase === "ready" &&
				!control.requested_controller &&
				(!control.current_page || !sameBrowserPage(page, control.current_page))
			)
				void run(() => session.input({ kind: "select_page" }, page));
		},
		handoff: (target: string, expected?: BrowserControllerLease | null) =>
			run(async () => {
				await session?.handoff(target, expected);
			}),
		selectDefaultBrowser: () =>
			run(async () => {
				if (renderedSelection !== selection.current || !session || !connection)
					return;
				await connection.client.selectResource(
					session.resource,
					crypto.randomUUID(),
				);
			}),
		create: () => run(create),
		navigate: (url: string) =>
			run(async (current) => {
				if (
					renderedSelection !== selection.current ||
					!visible ||
					!workspaceActive
				)
					return;
				const opened = session ?? (await create(current));
				if (!opened || !current() || !active.current) return;
				if (!session) {
					await opened.refresh();
					if (!current() || !active.current) return;
					await opened.handoff(controllerId);
					if (!current() || !active.current) return;
				}
				await opened.input({ kind: "navigate", url });
			}),
		close: () =>
			run(async (current) => {
				if (!session || !connection) return;
				await connection.client.close(session.resource, crypto.randomUUID());
				await session.dispose(false);
				if (!current()) return;
				setSession(undefined);
				setResources((rows) =>
					rows.filter(
						(row) => row.resource.resource_id !== session.resource.resource_id,
					),
				);
				persist({
					authority: connection.authority,
					workspaceId: session.resource.workspace_id,
				});
			}),
	};
}
