function parseCreationDate(value) {
  var match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(
    String(value)
  );
  if (!match) return null;
  var offsetMinutes = Number(match[9]) * (match[8] === "+" ? 1 : -1);
  var localMilliseconds = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Math.floor(Number(match[7]) / 1000)
  );
  var startedAtUnixSeconds = Math.floor(
    (localMilliseconds - offsetMinutes * 60 * 1000) / 1000
  );
  var startedAtUnixMicroseconds =
    startedAtUnixSeconds * 1000000 + Number(match[7]);
  if (
    !isFinite(startedAtUnixSeconds) ||
    startedAtUnixSeconds <= 0 ||
    !isFinite(startedAtUnixMicroseconds) ||
    startedAtUnixMicroseconds > 9007199254740991
  ) {
    return null;
  }
  return {
    startedAtUnixSeconds: startedAtUnixSeconds,
    token: String(startedAtUnixMicroseconds)
  };
}

function main() {
  if (WScript.Arguments.length < 1 || WScript.Arguments.Item(0) !== "observe-point") {
    throw new Error("unsupported Windows process observation");
  }
  var requested = {};
  var pids = [];
  for (var index = 1; index < WScript.Arguments.length; index += 1) {
    var rawPid = String(WScript.Arguments.Item(index));
    if (!/^[1-9]\d{0,9}$/.test(rawPid)) {
      throw new Error("invalid Windows process id");
    }
    var pid = Number(rawPid);
    if (pid > 0xffffffff) {
      throw new Error("invalid Windows process id");
    }
    if (!Object.prototype.hasOwnProperty.call(requested, rawPid)) {
      requested[rawPid] = true;
      pids.push(pid);
    }
  }
  pids.sort(function compare(left, right) {
    return left - right;
  });
  if (pids.length === 0) return;

  var service = GetObject(
    "winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2"
  );
  var clauses = [];
  for (var clauseIndex = 0; clauseIndex < pids.length; clauseIndex += 1) {
    clauses.push("ProcessId = " + pids[clauseIndex]);
  }
  var rows = new Enumerator(
    service.ExecQuery(
      "SELECT ProcessId, CreationDate FROM Win32_Process WHERE " +
        clauses.join(" OR ")
    )
  );
  var observed = {};
  for (; !rows.atEnd(); rows.moveNext()) {
    var row = rows.item();
    var observedPid = Number(row.ProcessId);
    var key = String(observedPid);
    var creation = parseCreationDate(row.CreationDate);
    if (
      !Object.prototype.hasOwnProperty.call(requested, key) ||
      Object.prototype.hasOwnProperty.call(observed, key) ||
      !creation
    ) {
      throw new Error("invalid Windows process observation");
    }
    observed[key] = creation;
  }
  for (var outputIndex = 0; outputIndex < pids.length; outputIndex += 1) {
    var outputPid = pids[outputIndex];
    var output = observed[String(outputPid)];
    if (!output) continue;
    WScript.StdOut.WriteLine(
      "M " +
        outputPid +
        " live windows:" +
        outputPid +
        ":" +
        output.token +
        " " +
        output.startedAtUnixSeconds
    );
  }
}

try {
  main();
} catch (error) {
  WScript.StdErr.WriteLine(error && error.message ? error.message : String(error));
  WScript.Quit(1);
}
