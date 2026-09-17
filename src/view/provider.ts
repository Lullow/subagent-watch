import * as vscode from "vscode";
import { ViewTarget } from "./host.ts";
import type { ViewSnapshot } from "./types.ts";

export const VIEW_ID = "subagentWatch.view";
export const EDITOR_TYPE = "subagentWatch.editor";

/** Q4: a webview in the bottom panel, which can also be dragged to the side bar. */
export class SubagentViewProvider implements vscode.WebviewViewProvider {
  private readonly extensionUri: vscode.Uri;
  private view: vscode.WebviewView | undefined;
  private target: ViewTarget | undefined;
  private snapshot: ViewSnapshot | null = null;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  get webviewReady(): boolean {
    return this.target?.webviewReady ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.target = new ViewTarget(view.webview, this.extensionUri, "panel", () => view.visible);
    if (this.snapshot !== null) this.target.update(this.snapshot);
    view.onDidChangeVisibility(() => this.target?.refresh());
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.target = undefined;
      }
    });
  }

  update(snapshot: ViewSnapshot): void {
    this.snapshot = snapshot;
    this.target?.update(snapshot);
  }
}

/** A tab in the editor area, for when the timeline needs the full width. */
export class EditorViews implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly panels = new Map<vscode.WebviewPanel, ViewTarget>();
  private snapshot: ViewSnapshot | null = null;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  open(): void {
    const first = [...this.panels.keys()][0];
    if (first !== undefined) return first.reveal();
    const panel = vscode.window.createWebviewPanel(EDITOR_TYPE, "subagent-watch", vscode.ViewColumn.Active, { enableScripts: true, enableCommandUris: false });
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "subagent-watch.svg");
    const target = new ViewTarget(panel.webview, this.extensionUri, "editor", () => panel.visible);
    this.panels.set(panel, target);
    if (this.snapshot !== null) target.update(this.snapshot);
    panel.onDidChangeViewState(() => target.refresh());
    panel.onDidDispose(() => this.panels.delete(panel));
  }

  update(snapshot: ViewSnapshot): void {
    this.snapshot = snapshot;
    for (const target of this.panels.values()) target.update(snapshot);
  }

  get count(): number {
    return this.panels.size;
  }

  dispose(): void {
    for (const panel of [...this.panels.keys()]) panel.dispose();
  }
}
