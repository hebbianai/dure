import { createAccountDir } from "@/lib/ipc";
import { ensureQaLocalProject } from "@/lib/qa/qaLocalProject";
import { useStore } from "@/store";
import { runManagedCredentialCrossBindingQa } from "./managedCredentialCrossBindingQa";

export async function runHmuxSessionConversionQaFlag(
	flag: string,
	log: (...args: unknown[]) => void,
): Promise<void> {
	const path = flag.match(/^hmuxconversion-project=(.+)$/mu)?.[1];
	if (!path) return;
	const project = await ensureQaLocalProject(path);
	log("hmuxconversion-project", project);
	const profileName = flag.match(/^hmuxcredential-profile=(.+)$/mu)?.[1];
	if (!profileName) return;
	const name = profileName.trim();
	const directory = await createAccountDir("codex", name);
	const account = useStore.getState().addAccount({
		provider: "codex",
		name,
		dir: directory,
	});
	log("hmuxcredential-profile", {
		ready: true,
		accountId: account.id,
		directory,
	});
	try {
		await runManagedCredentialCrossBindingQa(project.projectId, account, log);
	} finally {
		useStore.getState().removeAccount(account.id);
	}
}
