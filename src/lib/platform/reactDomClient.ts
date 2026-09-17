// Keep this side-effect import before react-dom/client. React sees the one-read
// boundary while its module initializes, independently of import sorting.
import "./reactDevPerformanceTrackProbe";
import ReactDOM from "react-dom/client";

// Reading without calling restores defensively if a future React stops probing.
if (import.meta.env.DEV) void console.timeStamp;

export default ReactDOM;
