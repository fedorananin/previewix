import * as vscode from 'vscode';
import { ArchiveEditorProvider, compressToZip } from './archiveEditor';
import { registerFileTypes } from './associations';
import { AudioEditorProvider } from './audioEditor';
import { CertEditorProvider } from './certEditor';
import { CsvEditorProvider } from './csvEditor';
import { registerImageCompare } from './imageCompare';
import { ImageEditorProvider } from './imageEditor';
import { DocumentViewerProvider, PdfEditorProvider } from './documentViewer';
import { FontEditorProvider } from './fontEditor';
import { HtmlEditorProvider } from './htmlEditor';
import { MarkdownEditorProvider } from './markdownEditor';
import { ModelEditorProvider } from './modelEditor';
import { SqliteEditorProvider } from './sqliteEditor';
import { SvgEditorProvider } from './svgEditor';
import { TableEditorProvider } from './tableEditor';
import { VideoEditorProvider } from './videoEditor';

export function activate(context: vscode.ExtensionContext): void {
  // Earlier versions cached converted audio tracks here.
  void vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, 'audio'), { recursive: true }).then(undefined, () => undefined);
  context.subscriptions.push(
    registerFileTypes(context),
    // The comparison of two images: its commands, and the view itself, which is no custom editor.
    registerImageCompare(context),
    vscode.window.registerCustomEditorProvider(VideoEditorProvider.viewType, new VideoEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(AudioEditorProvider.viewType, new AudioEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      // Keeps unsaved tag edits, and lets the music play on, while the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(ImageEditorProvider.viewType, new ImageEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      // Keeps unsaved crops and annotations alive while the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // One editor per PDF: annotations and form values live in the page until they are saved, and two pages can't share them.
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, new PdfEditorProvider(context), {
      // Keeps those unsaved changes while the tab is in the background, and saves re-rendering a long PDF on every tab switch.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(DocumentViewerProvider.viewTypes.docx, new DocumentViewerProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
    }),
    vscode.window.registerCustomEditorProvider(MarkdownEditorProvider.viewType, new MarkdownEditorProvider(context), {
      webviewOptions: { enableFindWidget: true },
    }),
    vscode.window.registerCustomEditorProvider(HtmlEditorProvider.viewType, new HtmlEditorProvider(context), {
      // The same page can be open as a preview and, next to it, as text. It is not kept alive in the
      // background: a hidden page would go on running its scripts, and playing its sound.
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(FontEditorProvider.viewType, new FontEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(SqliteEditorProvider.viewType, new SqliteEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      // Keeps unsaved row edits alive while the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(ArchiveEditorProvider.viewType, new ArchiveEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
    }),
    // In the Explorer's context menu, for one or several files and folders.
    vscode.commands.registerCommand('previewix.compressToZip', compressToZip),
    // Delimited text is edited in its table, so it has a provider of its own that saves, undoes and backs up.
    vscode.window.registerCustomEditorProvider(TableEditorProvider.viewTypes.csv, new CsvEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      // Keeps the sort, filter, selection and scroll position, and saves parsing a large file again on every tab switch.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(TableEditorProvider.viewTypes.dbf, new TableEditorProvider(context, 'dbf'), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(TableEditorProvider.viewTypes.xlsx, new TableEditorProvider(context, 'xlsx'), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(TableEditorProvider.viewTypes.jsonl, new TableEditorProvider(context, 'jsonl'), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(TableEditorProvider.viewTypes.parquet, new TableEditorProvider(context, 'parquet'), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(SvgEditorProvider.viewType, new SvgEditorProvider(context), {
      // The same file can be open as a preview and, next to it, as text.
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.window.registerCustomEditorProvider(CertEditorProvider.viewType, new CertEditorProvider(context), {
      // The same PEM file can be open as a description and, next to it, as text.
      supportsMultipleEditorsPerDocument: true,
      // A trust bundle is a long page, and the find widget searches what is unfolded on it.
      webviewOptions: { enableFindWidget: true },
    }),
    vscode.window.registerCustomEditorProvider(ModelEditorProvider.viewType, new ModelEditorProvider(context), {
      // A .gltf or an .obj can be open as a model and, next to it, as text. The page is not kept alive in the
      // background: a hidden model would go on holding its geometry and textures on the GPU.
      supportsMultipleEditorsPerDocument: true,
    }),
    // The way back from the text editor to the rendered view, offered as a button in the editor title.
    ...[
      ['previewix.openMarkdownPreview', MarkdownEditorProvider.viewType],
      ['previewix.openHtmlPreview', HtmlEditorProvider.viewType],
      ['previewix.openSvgPreview', SvgEditorProvider.viewType],
      ['previewix.openModelPreview', ModelEditorProvider.viewType],
      ['previewix.openCsvPreview', TableEditorProvider.viewTypes.csv],
      ['previewix.openCertPreview', CertEditorProvider.viewType],
    ].map(([command, viewType]) =>
      vscode.commands.registerCommand(command, (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (target) {
          // One command serves the text files that open as a table: delimited text and JSON Lines, each with a view of its own.
          const view = viewType === TableEditorProvider.viewTypes.csv ? TableEditorProvider.textViewType(target) : viewType;
          return vscode.commands.executeCommand('vscode.openWith', target, view, vscode.window.activeTextEditor?.viewColumn);
        }
      }),
    ),
  );
}

export function deactivate(): void {}
