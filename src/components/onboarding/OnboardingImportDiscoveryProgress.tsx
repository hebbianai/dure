import { CircleAlert, CircleCheck, Laptop, Server } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { DureLoader } from "@/components/ui/dure-loader";
import { t } from "@/lib/i18n";
import type { ProviderConversationDiscoverySource } from "@/lib/agents/providerConversationDiscovery";

export function OnboardingImportDiscoveryProgress({
	sources,
	complete,
}: {
	sources: readonly ProviderConversationDiscoverySource[];
	complete: boolean;
}) {
	const failed = sources.filter((source) => source.status === "failed");
	const visibleSources = complete ? failed : sources;
	if (visibleSources.length === 0) return null;
	if (complete) {
		return (
			<Alert
				data-onboarding-import-discovery-progress
				role="status"
				tone="warn"
				title={t("onboarding.import.discovery.partialFailure")}
			>
				<OnboardingImportDiscoverySources sources={visibleSources} />
			</Alert>
		);
	}
	const completedCount = sources.filter(
		(source) => source.status !== "pending",
	).length;

	return (
		<div
			data-onboarding-import-discovery-progress
			aria-live="polite"
			className="rounded-md bg-background/35 px-2.5 py-2 text-[10px]"
		>
			<div className="flex items-center gap-1.5 font-medium text-foreground">
				<DureLoader decorative className="text-muted-foreground" />
				<span>
					{t("onboarding.import.discovery.progress", {
						completed: completedCount,
						total: sources.length,
					})}
				</span>
			</div>
			<OnboardingImportDiscoverySources sources={visibleSources} />
		</div>
	);
}

export function OnboardingImportDiscoverySources({
	sources,
}: {
	sources: readonly ProviderConversationDiscoverySource[];
}) {
	if (sources.length === 0) return null;
	return (
		<div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px]">
			{sources.map((source) => (
				<div
					key={source.key}
					data-discovery-source={source.key}
					data-discovery-status={source.status}
					className="flex min-w-0 items-center gap-1 rounded bg-muted/35 px-1.5 py-1 text-muted-foreground"
				>
					{source.kind === "local" ? (
						<Laptop className="size-2.5 shrink-0" />
					) : (
						<Server className="size-2.5 shrink-0" />
					)}
					<span className="max-w-40 truncate">
						{source.kind === "local"
							? t("onboarding.import.discovery.localHost")
							: (source.label ??
								source.hostId ??
								t("onboarding.import.discovery.unknownHost"))}
					</span>
					{source.status === "pending" ? (
						<>
							<DureLoader decorative size={10} />
							<span>{t("onboarding.import.discovery.scanning")}</span>
						</>
					) : source.status === "succeeded" ? (
						<>
							<CircleCheck className="size-2.5 text-status-run" />
							<span>
								{t("onboarding.import.discovery.foundCount", {
									n: source.count,
								})}
							</span>
						</>
					) : (
						<>
							<CircleAlert className="size-2.5 text-status-warn" />
							<span className="text-status-warn">
								{t("onboarding.import.discovery.failed")}
							</span>
						</>
					)}
				</div>
			))}
		</div>
	);
}
