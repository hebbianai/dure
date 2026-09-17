import { OverflowRevealText } from "@/components/ui/overflow-reveal-text";
import { UserRound } from "lucide-react";
import { Avatar } from "radix-ui";
import { githubAvatarUrl } from "@/lib/github/githubIssueDetails";
import { t } from "@/lib/i18n";

export function GitHubActor({
	login,
	repositoryUrl,
}: {
	login: string;
	repositoryUrl: string;
}) {
	const name = login || t("github.detail.unknownAuthor");
	return (
		<span
			className="inline-flex min-w-0 max-w-full items-center gap-1.5"
		>
			<Avatar.Root
				aria-hidden="true"
				className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
			>
				<Avatar.Image
					src={githubAvatarUrl(login, repositoryUrl)}
					alt=""
					referrerPolicy="no-referrer"
					decoding="async"
					className="size-full object-cover"
				/>
				<Avatar.Fallback>
					{login ? (
						login.slice(0, 1).toUpperCase()
					) : (
						<UserRound className="size-3" />
					)}
				</Avatar.Fallback>
			</Avatar.Root>
			<OverflowRevealText text={name} />
		</span>
	);
}
