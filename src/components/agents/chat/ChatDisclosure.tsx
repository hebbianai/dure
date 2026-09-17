import {
	type ComponentProps,
	createContext,
	type ReactNode,
	useContext,
	useState,
} from "react";

export const ChatDisclosureState = createContext<Map<string, boolean> | null>(
	null,
);

/** Native disclosure interaction, with its presentation state retained while
 * virtualization releases the row's DOM and attachment/Markdown resources. */
export function ChatDisclosure({
	disclosureKey,
	open,
	onToggle,
	children,
	...props
}: Omit<ComponentProps<"details">, "children"> & {
	disclosureKey: string;
	children?: ReactNode | ((expanded: boolean) => ReactNode);
}) {
	const state = useContext(ChatDisclosureState);
	// Native details owns expansion; lazy bodies also honor restored row state.
	const [expanded, setExpanded] = useState(
		() => state?.get(disclosureKey) ?? open ?? false,
	);
	return (
		<details
			{...props}
			open={state?.get(disclosureKey) ?? open}
			onToggle={(event) => {
				state?.set(disclosureKey, event.currentTarget.open);
				setExpanded(event.currentTarget.open);
				onToggle?.(event);
			}}
		>
			{typeof children === "function" ? children(expanded) : children}
		</details>
	);
}
