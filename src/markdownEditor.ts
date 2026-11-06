import * as vscode from 'vscode';
import { planEdit, toggleTask, type BlockEdit } from './markdownEdit';
import { renderDocument, splitLines } from './markdownRender';
import { followFile, getNonce, missingAssets, parentOf } from './util';

/**
 * A rendered Markdown view in which every top-level block can be edited as source.
 * Only the lines of the edited block are rewritten, so the rest of the file keeps its formatting.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'previewix.markdown';
  /** Whether a newly opened document shows its outline: the last choice made in any Markdown tab. */
  private static readonly outlineKey = 'markdown.outline';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    // KaTeX's stylesheet and fonts, and Mermaid.
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const folder = parentOf(document.uri);
    webview.options = {
      enableScripts: true,
      // Images may live anywhere in the workspace, not just next to the document.
      localResourceRoots: [mediaRoot, distRoot, folder, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)],
    };
    webview.html = this.html(webview, mediaRoot, distRoot, folder);

    // Set while this editor's own edit is being applied, to tell it apart from changes made elsewhere.
    let ownRange: { start: number; end: number } | undefined;

    const sendUpdate = () => {
      const text = document.getText();
      webview.postMessage({
        type: 'update',
        version: document.version,
        lines: splitLines(text),
        ...renderDocument(text),
        own: !!ownRange,
        range: ownRange,
      });
    };

    const subscription = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length) {
        sendUpdate();
      }
    });
    panel.onDidDispose(() => subscription.dispose());
    // The text itself is kept in step by VS Code; unsaved edits stay on screen even when the file is gone.
    followFile(panel, document.uri, MarkdownEditorProvider.viewType, { keep: () => document.isDirty });

    const applyBlockEdit = async (msg: BlockEdit & { version: number }) => {
      // The line numbers are only meaningful for the version the webview has seen.
      if (msg.version !== document.version) {
        webview.postMessage({ type: 'rejected' });
        return;
      }
      const plan = planEdit(splitLines(document.getText()), msg);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(...plan.from, ...plan.to), plan.text);
      ownRange = { start: plan.start, end: plan.end };
      try {
        await vscode.workspace.applyEdit(edit);
      } finally {
        ownRange = undefined;
      }
      webview.postMessage({ type: 'applied', version: document.version, start: plan.start, end: plan.end });
    };

    const toggleTaskAt = async (line: number) => {
      if (line >= document.lineCount) {
        return;
      }
      const current = document.lineAt(line);
      const toggled = toggleTask(current.text);
      if (toggled !== undefined) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, current.range, toggled);
        await vscode.workspace.applyEdit(edit);
      }
    };

    const openLink = async (href: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        await vscode.env.openExternal(vscode.Uri.parse(href));
        return;
      }
      const [target] = href.split('#');
      const uri = vscode.Uri.joinPath(folder, decodeURIComponent(target));
      await vscode.commands.executeCommand('vscode.open', uri);
    };

    // Messages are handled one at a time: edits must be applied in the order they were made.
    let queue: Promise<unknown> = Promise.resolve();
    webview.onDidReceiveMessage((msg) => {
      queue = queue
        .then(async () => {
          switch (msg.type) {
            case 'ready':
              sendUpdate();
              break;
            case 'edit':
              await applyBlockEdit(msg);
              break;
            case 'toggleTask':
              await toggleTaskAt(msg.line);
              break;
            case 'save':
              await document.save();
              break;
            case 'openLink':
              await openLink(msg.href);
              break;
            case 'outline':
              await this.context.globalState.update(MarkdownEditorProvider.outlineKey, !!msg.open);
              break;
            case 'openSource':
              // Same editor group as the preview, not a split.
              await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', panel.viewColumn);
              break;
          }
        })
        .catch((e) => vscode.window.showErrorMessage(`Previewix: ${e instanceof Error ? e.message : e}`));
    });
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri, distRoot: vscode.Uri, folder: vscode.Uri): string {
    const nonce = getNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'markdown.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'markdown.js'));
    const katexCss = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'katex', 'katex.min.css'));
    // Not a script tag: the page imports Mermaid when the document turns out to have a diagram.
    const mermaid = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'mermaid', 'mermaid.js'));
    const outline = this.context.globalState.get(MarkdownEditorProvider.outlineKey, false) ? 'open' : 'closed';
    // Makes relative image paths resolve against the document's folder.
    const base = webview.asWebviewUri(folder).toString().replace(/\/?$/, '/');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <base href="${base}">
  <link rel="stylesheet" href="${katexCss}">
  <link rel="stylesheet" href="${css}">
  ${missingAssets(webview, mediaRoot, nonce)}
</head>
<body data-mermaid="${mermaid}" data-outline="${outline}">
  <header id="bar">
    <button id="outlineToggle" title="Show or hide the outline of the document" aria-pressed="false">Outline</button>
    <span id="hint">Double-click a block to edit it</span>
    <span id="toast"></span>
    <button id="source" title="Open the Markdown source in the text editor">Open source</button>
  </header>
  <nav id="outline" aria-label="Outline" hidden></nav>
  <main id="content"></main>
  <footer id="tail">
    <button id="add" title="Write a new block at the end of the document">+ Add block</button>
  </footer>
  <div id="stage" class="block" aria-hidden="true"></div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
