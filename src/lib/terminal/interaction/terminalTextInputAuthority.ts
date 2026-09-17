export interface TerminalTextInputAuthority {
	readonly attachmentCurrent: boolean;
	readonly keyboardOwnerCurrent: boolean;
}

export function terminalTextInputAuthorityIsCurrent(
	authority: TerminalTextInputAuthority,
): boolean {
	return authority.attachmentCurrent && authority.keyboardOwnerCurrent;
}

export function terminalTextInputMayForward(
	authority: TerminalTextInputAuthority,
	text: string,
): boolean {
	return terminalTextInputAuthorityIsCurrent(authority) && text.length > 0;
}
