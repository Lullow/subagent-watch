import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { viewHtml } from "./html.ts";
import { COPYABLE_COMMANDS, type ToWebview, type ViewSnapshot } from "./types.ts";

/** The webview keeps its own clock in step with the extension host's. */
const RESYNC_MS = 5000;

/** Where the view is shown. The panel and the side bar are narrow, so their content sits at the bottom. */
export type Place = "panel" | "editor";

/** One webview showing subagent-watch: the view in the panel, or a tab in the editor area. */
export class ViewTarget {
  private readonly webview: vscode.Webview;
  private readonly isVisible: () => boolean;
  private snapshot: ViewSnapshot | null = null;
  private sentSignature = "";
  private sentAt = 0;
  private ready = false;

  constructor(webview: vscode.Webview, extensionUri: vscode.Uri, place: Place, isVisible: () => boolean) {
    this.webview = webview;
    this.isVisible = isVisible;
    const dist = vscode.Uri.joinPath(extensionUri, "dist");
    webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [dist] };
    webview.html = viewHtml({
      cspSource: webview.cspSource,
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, "view.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(dist, "view.css")).toString(),
      nonce: randomBytes(18).toString("base64"),
      place,
    });
    webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
  }

  /** True once the webview's script has run, which the content security policy would otherwise block. */
  get webviewReady(): boolean {
    return this.ready;
  }

  update(snapshot: ViewSnapshot): void {
    this.snapshot = snapshot;
    this.post(false);
  }

  /** Called when the view becomes visible again, so it never shows stale data. */
  refresh(): void {
    if (this.isVisible()) this.post(true);
  }

  private post(force: boolean): void {
    if (!this.isVisible() || this.snapshot === null || !this.ready) return;
    const { now: _now, ...data } = this.snapshot;
    const signature = JSON.stringify(data);
    if (!force && signature === this.sentSignature && this.snapshot.now - this.sentAt < RESYNC_MS) return;
    this.sentSignature = signature;
    this.sentAt = this.snapshot.now;
    const message: ToWebview = { type: "snapshot", snapshot: this.snapshot };
    void this.webview.postMessage(message);
  }

  /** S10: messages from the webview are untrusted; only a known command may reach the clipboard. */
  private async receive(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const { type, command } = message as { type?: unknown; command?: unknown };
    if (type === "ready") {
      this.ready = true;
      this.post(true);
      return;
    }
    const known = COPYABLE_COMMANDS.find((candidate) => candidate === command);
    if (type === "copy" && known !== undefined) {
      await vscode.env.clipboard.writeText(known);
      const reply: ToWebview = { type: "copied", command: known };
      void this.webview.postMessage(reply);
    }
  }
}
