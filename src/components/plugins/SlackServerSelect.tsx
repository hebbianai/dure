import { useId } from "react";
import { FormField } from "@/components/common/FormField";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { t } from "@/lib/i18n";
import type { DureBackendProfileSummary } from "@/lib/ipc/dureBackendProfiles";

export function SlackServerSelect({
	profiles,
	value,
	onChange,
	label,
}: {
	profiles: DureBackendProfileSummary[];
	value?: string;
	onChange: (id: string) => void;
	label: string;
}) {
	const id = useId();
	return (
		<FormField label={label} htmlFor={id}>
			<Select value={value ?? ""} onValueChange={onChange}>
				<SelectTrigger id={id}>
					<SelectValue placeholder={label} />
				</SelectTrigger>
				<SelectContent>
					{profiles.map((profile) => (
						<SelectItem key={profile.id} value={profile.id}>
							{profile.kind === "local"
								? t("plugins.slack.thisComputer")
								: profile.id}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</FormField>
	);
}
