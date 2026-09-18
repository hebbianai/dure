// 브라우저 창 열기 (Design Mode 진입점 겸 일반 브라우저).
//
// 아무 http(s) 주소나 열 수 있고, **요소 집기는 localhost에서만** 된다. 주입이
// 없으면 픽커도 nonce 채널도 존재하지 않으므로 임의 사이트를 열어도 표면이 늘지
// 않는다. 그 차이를 입력 중에 미리 알린다 —
// 열고 나서 "왜 안 집히지"가 되지 않게.
import { useState } from "react";
import { ConfirmationButton } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

function isLoopbackUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		return (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host.endsWith(".localhost")
		);
	} catch {
		return false;
	}
}

export function DesignModeBrowserDialog({
	open,
	onOpenChange,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (url: string) => void;
}) {
	const [url, setUrl] = useState("http://localhost:3000");
	const valid = isLoopbackUrl(url);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("design.browser.title")}</DialogTitle>
				</DialogHeader>
				<p className="text-xs text-muted-foreground">
					{t("design.browser.addressDescription")}
				</p>
				<form
					className="mt-3 flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!valid) return;
						onSubmit(url);
						onOpenChange(false);
					}}
				>
					<Input
						value={url}
						onChange={(event) => setUrl(event.target.value)}
						placeholder="http://localhost:3000"
						aria-label={t("design.browser.addressLabel")}
						autoFocus
					/>
					<ConfirmationButton type="submit" disabled={!valid}>
						{t("common.open")}
					</ConfirmationButton>
				</form>
				{!valid && (
					<p className="mt-2 text-xs text-muted-foreground">
						{t("design.browser.localhostOnly")}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
