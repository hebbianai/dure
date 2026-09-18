/** Local input diagnostics contain option names, never supplied values. */
export class BrowserCommandError extends Error {
  constructor(code, message, hint, option) {
    super(code);
    this.diagnostic = { code, message, hint, ...(option === undefined ? {} : { option }) };
  }
}
