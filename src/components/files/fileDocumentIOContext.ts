import { createContext } from "react";
import type { FileDocumentIO } from "@/lib/files/fileDocument";
import { fileDocumentIO } from "@/lib/files/fileDocumentIO";

/** How a file viewer reads and writes its document. Panes use the default;
 * the presentation window provides the streaming read for its media. */
export const FileDocumentIOContext = createContext<FileDocumentIO>(fileDocumentIO);
