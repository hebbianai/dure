import { useEffect, useRef } from "react";

interface ViewerConfiguration {
	revision?: number;
	action?: "capture" | "compose" | "reconnect";
	text?: string;
}

interface BrowserFrame {
	sequence: number;
	data: string;
}

/** Disposable, dev-only engine feasibility probe; not the product input path. */
export function BrowserRuntimeQaRoot() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		const input = inputRef.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !input || !context) return;
		const channel = import.meta.env.VITE_DURE_BROWSER_QA_CHANNEL;
		const token = import.meta.env.VITE_DURE_BROWSER_QA_TOKEN;
		let stopped = false;
		let revision = 0;
		let sequence = 0;
		let frames = 0;
		let composing = false;
		const events: string[] = [];
		const committedText: string[] = [];
		const request = async (path: string, value?: unknown) => {
			const response = await fetch(`${channel}${path}`, {
				method: value === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: value === undefined ? undefined : JSON.stringify(value),
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) throw new Error(`QA channel ${response.status}`);
			return response.json();
		};
		const report = (value: object) =>
			request("/reports", { ...value, userAgent: navigator.userAgent });
		const commit = (text: string) => {
			events.push(`commit:${text}`);
			committedText.push(text);
		};
		const onCompositionStart = () => {
			composing = true;
			events.push("compositionstart");
		};
		const onCompositionEnd = (event: CompositionEvent) => {
			composing = false;
			events.push("compositionend");
			commit(event.data);
			input.value = "";
		};
		const onInput = (event: Event) => {
			const inputEvent = event as InputEvent;
			events.push(`input:${inputEvent.inputType}`);
			if (composing || inputEvent.isComposing || !input.value) return;
			commit(input.value);
			input.value = "";
		};
		input.addEventListener("compositionstart", onCompositionStart);
		input.addEventListener("compositionend", onCompositionEnd);
		input.addEventListener("input", onInput);
		const paint = async (frame: BrowserFrame) => {
			if (frame.sequence === sequence && frames > 0) return;
			const image = new Image();
			image.src = `data:image/jpeg;base64,${frame.data}`;
			await image.decode();
			if (stopped) return;
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			context.drawImage(image, 0, 0);
			sequence = frame.sequence;
			frames++;
			if (frames === 1)
				await report({
					type: "frame",
					revision,
					sequence,
					width: canvas.width,
					height: canvas.height,
				});
		};
		const poll = async () => {
			while (!stopped) {
				try {
					const configuration: ViewerConfiguration =
						await request("/configuration");
					const frame: BrowserFrame | null = await request("/frame");
					if (frame) await paint(frame);
					if (
						configuration.revision &&
						configuration.revision !== revision &&
						frames > 0
					) {
						revision = configuration.revision;
						if (configuration.action === "capture") {
							await report({
								type: "capture",
								revision,
								sequence,
								frames,
								png: canvas.toDataURL("image/png"),
							});
						} else if (configuration.action === "compose") {
							// Synthetic WebKit event ordering only; not physical OS IME evidence.
							input.dispatchEvent(
								new CompositionEvent("compositionstart", { data: "" }),
							);
							input.value = "ㅎ";
							input.dispatchEvent(
								new InputEvent("input", {
									data: "ㅎ",
									inputType: "insertCompositionText",
									isComposing: true,
								}),
							);
							input.value = configuration.text ?? "";
							input.dispatchEvent(
								new CompositionEvent("compositionend", { data: input.value }),
							);
							input.dispatchEvent(
								new InputEvent("input", {
									data: configuration.text,
									inputType: "insertText",
								}),
							);
							await report({
								type: "composed",
								revision,
								events: [...events],
								committedText: [...committedText],
								trusted: false,
							});
						} else if (configuration.action === "reconnect") {
							// Drop the viewer projection, then rehydrate the latest frame.
							frames = 0;
							context.clearRect(0, 0, canvas.width, canvas.height);
						}
					}
				} catch (error) {
					if (!stopped) console.error("[browser runtime QA]", error);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		};
		void poll();
		return () => {
			stopped = true;
			input.removeEventListener("compositionstart", onCompositionStart);
			input.removeEventListener("compositionend", onCompositionEnd);
			input.removeEventListener("input", onInput);
		};
	}, []);
	return (
		<main style={{ padding: 16, background: "white", color: "black" }}>
			<p>Browser runtime feasibility probe</p>
			<canvas ref={canvasRef} style={{ width: "100%" }} />
			<textarea ref={inputRef} aria-label="QA composition receiver" />
		</main>
	);
}
