import { useEffect, useId, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, ChevronUp, FileText, Folder, FolderOpen } from "lucide-react";
import type { Project, SshHostConfig } from "@/types";
import { browseRemoteDirectory, sshConfigHosts } from "@/lib/ipc";
import {
  normalizeSshConfigAlias,
  type SshConfigHostDraft,
  sshConfigHostDraft,
} from "@/lib/ssh/sshConfigRegistration";
import {
  createSshHostDurably,
  updateSshHostCredentialsDurably,
} from "@/lib/ssh/sshCredentialLifecycle";
import { sshHostSecretId } from "@/lib/ssh/sshCredentialClaim";
import { parseSshPort } from "@/lib/ssh/sshPort";
import { registerSshConfigHostDurably } from "@/lib/ssh/sshConfigRouteLifecycle";
import { remoteDirectoryInput, remoteDirectoryParent, remoteDirectoryQuery } from "@/lib/ssh/remoteDirectoryBrowser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ErrorText } from "@/components/ui/error-text";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";
import { DialogActionFooter } from "@/components/common/DialogActionFooter";
import { FormField } from "@/components/common/FormField";
import {
  useAddRemoteProjectDialogState,
} from "@/components/ssh/useSshHostDialogsState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ---------- add / edit ssh host dialog ----------

/** 불러오기 목록 한 줄 — 어느 설정 파일에서 왔는지까지 보여준다. */
type SshConfigOption = { key: string; label: string; draft: SshConfigHostDraft };

export function AddSshHostDialog({
  existing,
  prefill,
  onClose,
}: {
  existing?: SshHostConfig;
  /** 설정 파일에서 온 초안으로 폼을 채운 채 연다(등록 전이라 id가 없다). */
  prefill?: SshConfigHostDraft;
  onClose: () => void;
}) {
  const seed = existing ?? prefill;
  const [name, setName] = useState(seed?.name ?? "");
  const [sshConfigAlias, setSshConfigAlias] = useState(seed?.sshConfigAlias);
  const [host, setHost] = useState(seed?.host ?? "");
  const [port, setPort] = useState(String(seed?.port ?? 22));
  const [user, setUser] = useState(seed?.user ?? "");
  const [auth, setAuth] = useState<SshHostConfig["auth"]>(seed?.auth ?? "auto");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(seed?.keyPath ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configOptions, setConfigOptions] = useState<SshConfigOption[]>([]);
  const [configPick, setConfigPick] = useState("");
  // Select triggers cannot receive FormField's auto-generated id (the Radix
  // root renders no DOM), so those rows wire htmlFor to explicit trigger ids.
  const fieldId = useId();

  // 추가할 때만 ~/.ssh/config 를 읽어 불러오기 목록을 만든다 — 편집 중에 덮어쓰면
  // 저장된 값을 잃는다. 읽기 전용이라 실패하면 목록만 안 보이면 된다.
  useEffect(() => {
    if (existing) return;
    let disposed = false;
    void sshConfigHosts()
      .then((scan) => {
        if (disposed) return;
        setConfigOptions(
          scan.files.flatMap((file) =>
            file.hosts.map((h, i) => ({
              key: `${file.path}::${i}::${h.alias}`,
              label: `${h.alias} — ${file.displayPath}`,
              draft: sshConfigHostDraft(h, scan.defaultUser),
            })),
          ),
        );
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [existing]);

  /** 고른 호스트로 폼을 채운다 — 이후 사용자가 자유롭게 고칠 수 있다. */
  const applyConfigHost = (key: string) => {
    const picked = configOptions.find((o) => o.key === key);
    if (!picked) return;
    setConfigPick(key);
    setName(picked.draft.name);
    setSshConfigAlias(picked.draft.sshConfigAlias);
    setHost(picked.draft.host);
    setPort(String(picked.draft.port));
    setUser(picked.draft.user);
    setAuth(picked.draft.auth);
    setKeyPath(picked.draft.keyPath ?? "");
  };

  // A malformed port is refused where it was typed rather than coerced on the
  // way out — the old `parseInt(port, 10) || 22` saved 22 for "abc" and for
  // "0", and stored 99999 and -5 as written (owner report 2026-09-08).
  const parsedPort = parseSshPort(port);

  const submit = async () => {
    if (!host.trim() || !user.trim() || !parsedPort.ok) return;
    setBusy(true);
    setError(null);
    const data = {
      name: name.trim() || `${user.trim()}@${host.trim()}`,
      sshConfigAlias: normalizeSshConfigAlias(sshConfigAlias),
      host: host.trim(),
      port: parsedPort.port,
      user: user.trim(),
      auth,
      keyPath: auth === "key" ? keyPath : undefined,
    };
    try {
      if (!existing && auth === "password" && !password) {
        throw new Error(t("ssh.hostDialog.passwordRequired"));
      }
      if (existing) {
        await updateSshHostCredentialsDurably({
          expected: existing,
          next: data,
          password,
        });
      } else if (data.sshConfigAlias) {
        await registerSshConfigHostDurably({
          ...data,
          sshConfigAlias: data.sshConfigAlias,
        }, password);
      } else {
        await createSshHostDurably(data, password);
      }
      onClose();
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dismiss="none"
        className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? t("ssh.hostDialog.editTitle") : t("common.addSshHost")}</DialogTitle>
          <DialogDescription>
            {t("ssh.projectBrowser.sessionPersistenceNote")}
          </DialogDescription>
        </DialogHeader>
        {/* 16px between fields (Figma 17375:198691, spacing/4). No padding of
            its own — the dialog's own 16px block gap already separates this
            form from the header and the footer. */}
        <div className="grid gap-4">
          {configOptions.length > 0 && (
            <FormField
              label={t("ssh.hostDialog.importFromConfig")}
              htmlFor={`${fieldId}-config`}
            >
              <Select value={configPick} onValueChange={applyConfigHost}>
                <SelectTrigger id={`${fieldId}-config`}>
                  <SelectValue placeholder={t("ssh.hostDialog.chooseConfigHost")} />
                </SelectTrigger>
                <SelectContent>
                  {configOptions.map((o) => (
                    <SelectItem key={o.key} value={o.key}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <div className="grid grid-cols-3 gap-2">
            <FormField className="col-span-2" label={t("common.host")}>
              <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" />
            </FormField>
            <FormField
              label={t("ssh.hostDialog.port")}
              error={parsedPort.ok ? undefined : t("ssh.hostDialog.portInvalid")}
            >
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
                inputMode="numeric"
                aria-invalid={parsedPort.ok ? undefined : true}
              />
            </FormField>
          </div>
          <FormField label={t("common.user")}>
            <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="ubuntu" />
          </FormField>
          <FormField label={t("ssh.hostDialog.displayName")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ssh.hostDialog.displayNamePlaceholder")} />
          </FormField>
          <FormField label={t("ssh.hostDialog.auth")} htmlFor={`${fieldId}-auth`}>
            <Select value={auth} onValueChange={(v) => setAuth(v as SshHostConfig["auth"])}>
              <SelectTrigger id={`${fieldId}-auth`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("ssh.hostDialog.authAuto")}</SelectItem>
                <SelectItem value="key">{t("ssh.hostDialog.authKeyFile")}</SelectItem>
                <SelectItem value="password">{t("ssh.hostDialog.password")}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          {auth === "password" && (
            <FormField label={t("ssh.hostDialog.password")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  sshHostSecretId(existing) || existing?.password
                    ? t("ssh.hostDialog.passwordKeepHint")
                    : undefined
                }
              />
            </FormField>
          )}
          {auth === "key" && (
            <FormField
              label={t("ssh.hostDialog.keyFilePath")}
              htmlFor={`${fieldId}-key`}
              description={t("ssh.hostDialog.keyFilePathHint")}
            >
              <div className="flex gap-1.5">
                <Input
                  id={`${fieldId}-key`}
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="shrink-0"
                  title={t("ssh.hostDialog.chooseFile")}
                  onClick={async () => {
                    const picked = await openFileDialog({
                      multiple: false,
                      directory: false,
                      title: t("ssh.hostDialog.chooseKeyFile"),
                    });
                    if (typeof picked === "string") setKeyPath(picked);
                  }}
                >
                  <FolderOpen className="size-4" />
                </Button>
              </div>
            </FormField>
          )}
          {error && <ErrorText>{error}</ErrorText>}
        </div>
        <DialogActionFooter
          cancelLabel={t("common.cancel")}
          onCancel={onClose}
          confirmLabel={existing ? t("common.save") : t("common.add")}
          busyLabel={t("common.saving")}
          busy={busy}
          disabled={!host.trim() || !user.trim() || !parsedPort.ok}
          onConfirm={() => void submit()}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------- remote folder browser (원격 프로젝트 열기) ----------

export function AddRemoteProjectDialog({
  hostId,
  onClose,
  onResolved,
}: {
  hostId: string;
  onClose: () => void;
  /** 지정 시 선택한 폴더로 프로젝트를 확보(재사용/등록)해 넘긴다 — 원격
   *  디렉토리 브라우저를 다른 흐름(워크트리 에이전트)에서 재사용하는 경로. */
  onResolved?: (project: Project) => void;
}) {
  const { ensureProjectForPath, host } = useAddRemoteProjectDialogState(hostId);
  const [path, setPath] = useState<string>(""); // 현재 로드된 디렉토리
  const [input, setInput] = useState<string>(""); // 입력칸 텍스트 (경로+조각)
  const [dirs, setDirs] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [isRepo, setIsRepo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ operation: "browse" | "open"; message: string } | null>(null);
  const [history, setHistory] = useState<string[]>([]); // 방문 이력 (뒤로가기)

  const request = useRef(0);
  const pendingInput = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { fragment: frag } = remoteDirectoryQuery(input, path);

  // Every navigation owns its result, including the debounce interval before I/O.
  const browse = async (target: string | undefined, syncInput: boolean, generation = ++request.current) => {
    if (!host) return;
    clearTimeout(pendingInput.current);
    setLoading(true);
    setError(null);
    try {
      const result = await browseRemoteDirectory(host, target);
      if (generation !== request.current) return;
      setPath(result.path);
      if (syncInput) setInput(remoteDirectoryInput(result.path));
      setIsRepo(result.isRepo);
      const entries = result.entries.filter((entry) => !entry.name.startsWith("."));
      setDirs(entries.filter((entry) => entry.isDir).map((entry) => entry.name));
      setFiles(entries.filter((entry) => !entry.isDir).map((entry) => entry.name));
    } catch (e) {
      if (generation !== request.current) return;
      setError({ operation: "browse", message: String(e) });
      setDirs([]);
      setFiles([]);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    setPath("");
    setInput("");
    setHistory([]);
    void browse(undefined, true);
    return () => { ++request.current; clearTimeout(pendingInput.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  const changeInput = (value: string) => {
    setInput(value);
    clearTimeout(pendingInput.current);
    const { directory } = remoteDirectoryQuery(value, path);
    // A fragment only filters the current snapshot. During a failed or pending
    // navigation, returning to this directory must establish a fresh snapshot.
    if (directory === path && !loading && !error) return;
    const generation = ++request.current;
    setLoading(true);
    setError(null);
    pendingInput.current = setTimeout(() => void browse(directory || undefined, false, generation), 250);
  };

  // 이력을 쌓으며 이동 (클릭/버튼). 입력칸도 해당 경로로 동기화.
  const navigate = (target: string) => {
    setHistory((h) => (path ? [...h, path] : h));
    browse(target, true);
  };
  const goBack = () => {
    const target = history[history.length - 1];
    if (!target) return;
    setHistory((h) => h.slice(0, -1));
    void browse(target, true);
  };

  const select = async () => {
    if (!path || loading || error?.operation === "browse") return;
    setBusy(true);
    setError(null);
    try {
      const project = await ensureProjectForPath(path, hostId);
      onResolved?.(project);
      onClose();
    } catch (e) {
      setError({ operation: "open", message: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const parent = remoteDirectoryParent(path);
  const fl = frag.toLowerCase();
  const shownDirs = dirs.filter((d) => d.toLowerCase().startsWith(fl));
  const shownFiles = files.filter((f) => f.toLowerCase().startsWith(fl));

  // 키보드 탐색 대상: (필터 없을 때) ".." + 폴더들. 파일은 진입 대상 아님.
  const navItems: { label: string; target: string }[] = loading ? [] : [
    ...(!frag && path && parent !== path && error?.operation !== "browse" ? [{ label: "..", target: parent }] : []),
    ...shownDirs.map((d) => ({ label: d, target: `${remoteDirectoryInput(path)}${d}` })),
  ];
  const [hi, setHi] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  // 목록이 바뀌면 하이라이트 초기화
  useEffect(() => setHi(-1), [path, frag]);
  // 하이라이트가 보이도록 스크롤
  useEffect(() => {
    if (hi < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-nav="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(navItems.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(-1, h - 1));
    } else if (e.key === "Enter" && hi >= 0 && navItems[hi]) {
      e.preventDefault();
      navigate(navItems[hi].target);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        dismiss="none"
        className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ssh.projectBrowser.title")} — {host?.name}</DialogTitle>
          <DialogDescription>
            {t("ssh.projectBrowser.hint")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-w-0 grid-cols-1 gap-2 py-1">
          <div className="flex gap-1.5">
            <Button
              variant="secondary"
              size="icon-sm"
              title={t("ssh.projectBrowser.back")}
              disabled={history.length === 0}
              onClick={goBack}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <Button
              variant="secondary"
              size="icon-sm"
              title={t("ssh.projectBrowser.parentFolder")}
              disabled={parent === path || !path}
              onClick={() => navigate(parent)}
            >
              <ChevronUp className="size-4" />
            </Button>
            <Input
              autoFocus
              value={input}
              onChange={(e) => changeInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              className="font-mono text-xs"
              placeholder={t("ssh.projectBrowser.pathPlaceholder")}
            />
          </div>
          <div ref={listRef} className="h-64 overflow-y-auto rounded-md border">
            {loading ? (
              <p className="p-3 text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : (
              <div className="p-1">
                {navItems.map((it, i) => (
                  <button type="button"
                    key={`n/${it.label}`}
                    data-nav={i}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent",
                      hi === i && "bg-accent",
                    )}
                    onMouseEnter={() => setHi(i)}
                    onClick={() => navigate(it.target)}
                  >
                    {it.label === ".." ? (
                      <ChevronUp className="size-3.5 text-muted-foreground" />
                    ) : (
                      <Folder className="size-3.5 shrink-0 text-status-done/80" />
                    )}
                    <span className="truncate">{it.label}</span>
                  </button>
                ))}
                {shownFiles.map((f) => (
                  <div
                    key={`f/${f}`}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-muted-foreground/70"
                  >
                    <FileText className="size-3.5 shrink-0" />
                    <span className="truncate">{f}</span>
                  </div>
                ))}
                {error?.operation !== "browse" && shownDirs.length === 0 && shownFiles.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    {frag ? t("common.noMatches") : t("ssh.projectBrowser.empty")}
                  </p>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{path}</span>
            {isRepo && (
              <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px]">
                git
              </Badge>
            )}
          </div>
          {error && <ErrorText className="break-all">{error.message}</ErrorText>}
        </div>
        <DialogActionFooter
          cancelLabel={t("common.cancel")}
          onCancel={onClose}
          confirmLabel={t("ssh.projectBrowser.openFolder")}
          busyLabel={t("common.opening")}
          busy={busy}
          disabled={loading || !path || error?.operation === "browse"}
          onConfirm={select}
        />
      </DialogContent>
    </Dialog>
  );
}
