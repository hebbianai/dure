// Boot entry, loaded by index.html ahead of main.tsx. It imports only the
// pure dot-field math and the mark geometry, so it runs long before the app
// graph has resolved — which is the whole point (lib/workspace/boot/bootSplash).
import { installBootSplash } from "@/lib/workspace/boot/bootSplash";

installBootSplash(document);
