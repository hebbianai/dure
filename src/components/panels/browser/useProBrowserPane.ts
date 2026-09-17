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
import { browserWorkspaceCatalog } from "@/lib/browser/browserWorkspaceCatalog";
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
	type BrowserWorkspace,
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
	const [workspaces, setWorkspaces] = useState<BrowserWorkspace[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [workspaceId, setWorkspaceId] = useState("");
	const [resources, setResources] = useState<BrowserControlProjection[]>([]);
	const [session, setSession] = useState<BrowserPaneSession>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<unknown>();
	const selection = useRef(0);
	const operation = useRef(0);
	const [restored] = useState(() => readBrowserPaneBinding(props.params));
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
				return await connection.client.create(
					pending.workspaceId,
					pending.operationId,
				);
			} catch (error) {
				if (
					current() &&
					creation.current === pending &&
					isUnstartedBrowserCreation(error)
				) {
					creation.current = undefined;
					const binding = savedBinding.current;
					persist(
						binding?.workspaceId === pending.workspaceId &&
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
	const connect = useCallback(async () => {
		++selection.current;
		setSession(undefined);
		setConnection(undefined);
		setResources([]);
		setWorkspaces([]);
		setWorkspaceId("");
		setNext(null);
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
			let workspaceId = pending
				? (pending.workspaceId ?? undefined)
				: binding?.workspaceId;
			let resource = pending ? undefined : binding?.resource;
			const client = createDureBrowserClient(authority);
			const catalog = await browserWorkspaceCatalog(
				client,
				workspaceId,
				current,
			);
			const rows = catalog.workspaces;
			if (!current()) return;
			if (rebound && !rows.some((row) => row.workspace_id === workspaceId)) {
				binding = undefined;
				workspaceId = undefined;
				resource = undefined;
			}
			setConnection({ authority, client });
			setWorkspaces(rows);
			setNext(catalog.next);
			setWorkspaceId(workspaceId ?? "");
			if (workspaceId || pending) {
				let resources = workspaceId ? await client.list(workspaceId) : [];
				if (!current()) return;
				if (pending) {
					const created = await createResource(
						{ authority, client },
						pending,
						current,
					);
					if (!current()) return;
					resource = created.resource;
					workspaceId = resource.workspace_id;
					setWorkspaceId(workspaceId);
					resources = [
						...resources.filter(
							(row) => !sameBrowserResource(row.resource, created.resource),
						),
						created,
					];
					creation.current = undefined;
					persist({ authority, workspaceId, resource });
				}
				setResources(resources);
				if (
					resource &&
					!resources.some((row) => sameBrowserResource(row.resource, resource!))
				)
					throw new Error("browser_saved_resource_missing");
				if (resource)
					setSession(
						new BrowserPaneSession(
							client,
							resource,
							controllerId,
							pending || binding?.followCurrent ? undefined : binding?.pageId,
						),
					);
			}
			if (rebound && current()) persist(binding);
		});
	}, [controllerId, persist, run, createResource]);

	useEffect(() => {
		if (!revealed) return;
		void connect();
		return () => {
			selection.current++;
		};
	}, [revealed, connect]);
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
			void session.refresh();
		} else if (revealed) void connect();
	}, [
		props.params.browserBinding,
		props.params.browserCreation,
		session,
		connection,
		revealed,
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
		const targetWorkspace = workspaceId || null;
		const pending = creation.current;
		if (pending && pending.workspaceId !== targetWorkspace)
			throw new Error("browser_creation_pending");
		if (
			pending &&
			!sameDureBackendRouteAuthority(pending.authority, connection.authority)
		)
			throw new Error("browser_creation_route_changed");
		const operationId = pending?.operationId ?? crypto.randomUUID();
		creation.current = {
			authority: connection.authority,
			workspaceId: targetWorkspace,
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
		setWorkspaceId(created.resource.workspace_id);
		const attached = attach(created);
		const catalog = await browserWorkspaceCatalog(
			connection.client,
			created.resource.workspace_id,
			current,
		);
		if (!current()) return;
		setWorkspaces(catalog.workspaces);
		setNext(catalog.next);
		return attached;
	};
	const renderedSelection = selection.current;
	return {
		active: visible && workspaceActive,
		connected: !!connection,
		view,
		session,
		busy,
		error,
		controllerId,
		workspaces,
		workspaceId,
		resources,
		next,
		refreshAfterProfileDeletion: async () => {
			if (renderedSelection !== selection.current || !session || !connection)
				return;
			await run(async (current) => {
				const previous = session.read();
				setSession(undefined);
				await session.dispose(false);
				if (!current()) return;
				const rows = await connection.client.list(
					session.resource.workspace_id,
				);
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
		reconnect: () => void connect(),
		run,
		selectWorkspace: async (id: string) => {
			if (!connection) return;
			const ticket = ++selection.current;
			setWorkspaceId(id);
			setResources([]);
			setSession(undefined);
			persist(
				id ? { authority: connection.authority, workspaceId: id } : undefined,
			);
			await run(async () => {
				if (!id) return;
				const rows = await connection.client.list(id);
				if (ticket === selection.current) setResources(rows);
			});
		},
		loadMore: () =>
			run(async (current) => {
				if (!connection || !next) return;
				const page = await connection.client.workspaces(next);
				if (!current()) return;
				setWorkspaces((rows) => [
					...new Map(
						[...rows, ...page.workspaces].map((row) => [row.workspace_id, row]),
					).values(),
				]);
				setNext(page.next);
			}),
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
		useForWorkspace: () =>
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
