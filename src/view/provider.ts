import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { viewHtml } from "./html.ts";
import { COPYABLE_COMMANDS, type ToWebview, type ViewSnapshot } from "./types.ts";

export const VIEW_ID = "subagentWatch.view";
/** The webview keeps its own clock in step with the extension host's. */
const RESYNC_MS = 5000;

/** Q4: a webview in the bottom panel. */
export class SubagentViewProvider implements vscode.WebviewViewProvider {
  private readonly extensionUri: vscode.Uri;
  private view: vscode.WebviewView | undefined;
  private snapshot: ViewSnapshot | null = null;
  private sentSignature = "";
  private sentAt = 0;
  private readyReceived = false;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  /** True once the webview's script has run, which the content security policy would otherwise block. */
  get webviewReady(): boolean {
    return this.readyReceived;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.readyReceived = false;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [dist] };
    view.webview.html = viewHtml({
      cspSource: view.webview.cspSource,
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "view.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "view.css")).toString(),
      nonce: randomBytes(18).toString("base64"),
    });
    view.webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.post(true);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  update(snapshot: ViewSnapshot): void {
    this.snapshot = snapshot;
    this.post(false);
  }

  private post(force: boolean): void {
    if (this.view?.visible !== true || this.snapshot === null || !this.readyReceived) return;
    const { now: _now, ...data } = this.snapshot;
    const signature = JSON.stringify(data);
    if (!force && signature === this.sentSignature && this.snapshot.now - this.sentAt < RESYNC_MS) return;
    this.sentSignature = signature;
    this.sentAt = this.snapshot.now;
    const message: ToWebview = { type: "snapshot", snapshot: this.snapshot };
    void this.view.webview.postMessage(message);
  }

  /** S10: messages from the webview are untrusted; only a known command may reach the clipboard. */
  private async receive(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const { type, command } = message as { type?: unknown; command?: unknown };
    if (type === "ready") {
      this.readyReceived = true;
      this.post(true);
      return;
    }
    const known = COPYABLE_COMMANDS.find((candidate) => candidate === command);
    if (type === "copy" && known !== undefined) {
      await vscode.env.clipboard.writeText(known);
      const reply: ToWebview = { type: "copied", command: known };
      void this.view?.webview.postMessage(reply);
    }
  }
}
