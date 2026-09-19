import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as vscode from "vscode";
import { removeAll } from "./collector/store.ts";
import { layoutFor } from "./connect/plan.ts";
import { interpretSession } from "./model/interpret.ts";
import { SessionStore } from "./model/reader.ts";
import type { SessionModel } from "./model/types.ts";
import { windowView } from "./model/window.ts";
import { currentUid } from "./secure/fs.ts";
import { statusFacts, type InstallFacts } from "./status/health.ts";
import { readInstall } from "./status/read.ts";
import { EditorViews, SubagentViewProvider, VIEW_ID } from "./view/provider.ts";
import type { ViewSnapshot } from "./view/types.ts";

/** Only for the integration tests: read-only, and never returned outside VS Code's test mode. */
export interface TestApi {
  statusBarText(): string | null;
  snapshot(): ViewSnapshot | null;
  webviewReady(): boolean;
  editorCount(): number;
}

const OPEN_COMMAND = "subagentWatch.openView";
const EDITOR_COMMAND = "subagentWatch.openEditor";
const DELETE_COMMAND = "subagentWatch.deleteData";
/** Hooks write a line per event; reading only new lines each second is cheap. */
const REFRESH_EVERY_MS = 1000;
/** Checksums and the Node path change rarely (Q36). */
const INSTALL_EVERY_MS = 5000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const workspaceFolders = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

class Controller implements vscode.Disposable {
  private readonly uid = currentUid();
  private readonly userHome = homedir();
  private readonly layout = layoutFor(this.userHome);
  private readonly item = vscode.window.createStatusBarItem("subagentWatch.status", vscode.StatusBarAlignment.Right, 99);
  private readonly provider: SubagentViewProvider;
  private readonly editors: EditorViews;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: NodeJS.Timeout;
  private store = new SessionStore(this.layout.home, this.uid);
  private install: InstallFacts | null = null;
  private installReadAt = 0;
  private last: ViewSnapshot | null = null;

  constructor(extensionUri: vscode.Uri) {
    this.provider = new SubagentViewProvider(extensionUri);
    this.editors = new EditorViews(extensionUri);
    this.item.name = "subagent-watch";
    this.item.command = { command: OPEN_COMMAND, title: "Öppna subagent-watch" };
    this.disposables.push(
      vscode.window.registerWebviewViewProvider(VIEW_ID, this.provider),
      vscode.commands.registerCommand(OPEN_COMMAND, () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
      vscode.commands.registerCommand(EDITOR_COMMAND, () => this.editors.open()),
      vscode.commands.registerCommand(DELETE_COMMAND, () => this.deleteData()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
    this.timer = setInterval(() => this.refresh(), REFRESH_EVERY_MS);
    this.refresh();
  }

  get statusBarText(): string | null {
    return this.last === null || this.item.text === "" ? null : this.item.text;
  }

  get snapshot(): ViewSnapshot | null {
    return this.last;
  }

  get webviewReady(): boolean {
    return this.provider.webviewReady;
  }

  get editorCount(): number {
    return this.editors.count;
  }

  private refresh(): void {
    const now = Date.now();
    let sessions: SessionModel[] = [];
    let storeError: string | null = null;
    let dropped = 0;
    let anonymous = 0;
    let refused = 0;
    if (existsSync(this.layout.sessions)) {
      try {
        const data = this.store.refresh(now);
        sessions = data.sessions.map((s) => interpretSession(s.id, s.records, now));
        dropped = data.dropped + data.sessions.reduce((sum, s) => sum + s.rejected, 0);
        anonymous = data.anonymous;
        refused = data.unsafe.length;
      } catch (error) {
        storeError = messageOf(error);
      }
    }
    if (this.install === null || now - this.installReadAt >= INSTALL_EVERY_MS) {
      this.install = readInstall(this.layout, this.uid);
      this.installReadAt = now;
    }
    const lastEventAt = sessions.length === 0 ? null : Math.max(...sessions.map((s) => s.lastEventAt));
    const view = windowView(sessions, workspaceFolders(), this.userHome, now);
    const snapshot: ViewSnapshot = {
      now,
      sessions: view.sessions,
      others: view.others,
      status: statusFacts({ ...this.install, storeError, lastEventAt, dropped, anonymous, refused }),
    };
    this.last = snapshot;
    this.renderStatusBar(view.running, view.unknown);
    this.provider.update(snapshot);
    this.editors.update(snapshot);
  }

  /** Q11: one entry, only while agents run in the window's projects. */
  private renderStatusBar(running: number, unknown: number): void {
    if (running === 0 && unknown === 0) {
      this.item.text = "";
      this.item.hide();
      return;
    }
    this.item.text = `$(gear) ${[running > 0 ? String(running) : "", unknown > 0 ? "?" : ""].filter(Boolean).join(" ")}`;
    const parts = [
      running > 0 ? `${running} ${running === 1 ? "agent kör" : "agenter kör"}` : null,
      unknown > 0 ? `${unknown} ${unknown === 1 ? "agent" : "agenter"} i okänt läge` : null,
    ].filter(Boolean);
    this.item.tooltip = `${parts.join(", ")} i det här projektet. Klicka för att öppna subagent-watch.`;
    this.item.show();
  }

  /** Q17: deletes every session and problem file at once, after a confirmation in VS Code itself. */
  private async deleteData(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Radera all insamlad data från subagent-watch?",
      {
        modal: true,
        detail: `Alla sessionsfiler i ${this.layout.sessions} tas bort. Det går inte att ångra. Pluginet och insamlaren ligger kvar, så nya händelser sparas som vanligt.`,
      },
      "Radera",
    );
    if (choice !== "Radera") return;
    try {
      const removed = existsSync(this.layout.sessions) ? removeAll(this.layout.home, this.uid) : 0;
      this.store = new SessionStore(this.layout.home, this.uid);
      this.refresh();
      void vscode.window.showInformationMessage(`subagent-watch raderade ${removed} ${removed === 1 ? "fil" : "filer"}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`subagent-watch kunde inte radera datan: ${messageOf(error)}`);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.item.dispose();
    this.editors.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const controller = new Controller(context.extensionUri);
  context.subscriptions.push(controller);
  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
  return {
    statusBarText: () => controller.statusBarText,
    snapshot: () => controller.snapshot,
    webviewReady: () => controller.webviewReady,
    editorCount: () => controller.editorCount,
  };
}

export function deactivate(): void {
  // Disposed through the extension context.
}
