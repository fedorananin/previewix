import * as vscode from 'vscode';

/** The editor VS Code itself has for a file type, with the extensions it accepts. Everything else goes to the text editor. */
const BUILT_IN: Record<string, { id: string; extensions: string[] }> = {
  'previewix.image': { id: 'imagePreview.previewEditor', extensions: ['jpg', 'jpe', 'jpeg', 'png', 'bmp', 'gif', 'ico', 'webp', 'avif'] },
  'previewix.video': { id: 'vscode.videoPreview', extensions: ['mp4', 'webm'] },
  'previewix.audio': { id: 'vscode.audioPreview', extensions: ['mp3', 'wav', 'ogg', 'oga'] },
};
const TEXT_EDITOR = 'default';
const SETTING = 'editorAssociations';
const INTRODUCED = 'previewix.introduced';
const INTRODUCED_HTML = 'previewix.introducedHtml';

export interface Viewer {
  viewType: string;
  name: string;
  /** What comes after `*.` in the patterns of the viewer: `png`, `tar.gz`. Lower case, each once. */
  extensions: string[];
}

interface Contribution {
  viewType: string;
  displayName: string;
  selector: { filenamePattern?: string }[];
}

/** `*.{png,PNG,jpg}` and `*.tar.gz` as lists of extensions. A pattern of another shape has no association to write. */
export function extensionsOf(pattern: string): string[] {
  const group = /^\*\.\{([^{}]+)\}$/.exec(pattern);
  if (group) {
    return group[1].split(',').map((ext) => ext.trim().toLowerCase());
  }
  return /^\*\.[^*?{}[\]/]+$/.test(pattern) ? [pattern.slice(2).toLowerCase()] : [];
}

/** The viewers as `package.json` declares them, so a new one shows up here without being listed again. */
export function viewersOf(customEditors: Contribution[]): Viewer[] {
  return customEditors.map((editor) => ({
    viewType: editor.viewType,
    name: editor.displayName.replace(/^Previewix\s+/, ''),
    extensions: [...new Set(editor.selector.flatMap((entry) => extensionsOf(entry.filenamePattern ?? '')))],
  }));
}

/** A viewer counts as switched off only when every one of its extensions has been given to another editor. */
export function isOn(viewer: Viewer, associations: Record<string, string>): boolean {
  return viewer.extensions.some((ext) => {
    const editor = associations[`*.${ext}`];
    return editor === undefined || editor === viewer.viewType;
  });
}

/**
 * The associations after the user's choice. Only viewers whose state changes are touched: switching one off
 * hands each extension to VS Code's own viewer or the text editor, switching it on removes the entries, which
 * makes Previewix the default again.
 */
export function withChoice(viewers: Viewer[], associations: Record<string, string>, chosen: Set<string>): Record<string, string> {
  const next = { ...associations };
  for (const viewer of viewers) {
    const on = chosen.has(viewer.viewType);
    if (on === isOn(viewer, associations)) {
      continue;
    }
    const builtIn = BUILT_IN[viewer.viewType];
    for (const ext of viewer.extensions) {
      if (on) {
        delete next[`*.${ext}`];
      } else {
        next[`*.${ext}`] = builtIn?.extensions.includes(ext) ? builtIn.id : TEXT_EDITOR;
      }
    }
  }
  return next;
}

function summary(extensions: string[]): string {
  const shown = extensions.slice(0, 8).join(', ');
  return extensions.length > 8 ? `${shown} and ${extensions.length - 8} more` : shown;
}

async function chooseFileTypes(context: vscode.ExtensionContext): Promise<void> {
  const viewers = viewersOf(context.extension.packageJSON.contributes.customEditors);
  const config = vscode.workspace.getConfiguration('workbench');
  const inspected = config.inspect<Record<string, string>>(SETTING);
  // A workspace that sets its own associations hides the user's, so the choice has to be written there to have an effect.
  const inWorkspace = inspected?.workspaceValue !== undefined;
  const stored = (inWorkspace ? inspected?.workspaceValue : inspected?.globalValue) ?? {};
  const associations = typeof stored === 'object' && !Array.isArray(stored) ? stored : {};

  const picked = await vscode.window.showQuickPick(
    viewers.map((viewer) => ({
      label: viewer.name,
      description: summary(viewer.extensions),
      picked: isOn(viewer, associations),
      viewType: viewer.viewType,
    })),
    {
      canPickMany: true,
      title: 'File types that open in Previewix',
      placeHolder: "Unchecked types open in VS Code's own viewer or in the text editor",
      matchOnDescription: true,
    },
  );
  if (!picked) {
    return;
  }
  const next = withChoice(viewers, associations, new Set(picked.map((item) => item.viewType)));
  if (JSON.stringify(next) === JSON.stringify(associations)) {
    return;
  }
  await config.update(SETTING, next, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage('Previewix: file types updated. Tabs that are already open stay as they are.', 6000);
}

function introduce(message: string): void {
  void vscode.window
    .showInformationMessage(message, 'Choose File Types…')
    .then((answer) => answer && vscode.commands.executeCommand('previewix.chooseFileTypes'));
}

export function registerFileTypes(context: vscode.ExtensionContext): vscode.Disposable {
  const command = vscode.commands.registerCommand('previewix.chooseFileTypes', () => chooseFileTypes(context));
  // Taking over Markdown, HTML, CSV and SVG surprises people who wanted the text, so the way to opt out is shown once.
  if (!context.globalState.get(INTRODUCED)) {
    void context.globalState.update(INTRODUCED, true);
    void context.globalState.update(INTRODUCED_HTML, true);
    introduce('Previewix opens media, documents and data files, including Markdown, HTML, CSV and SVG. You can choose which file types it handles.');
  }
  return command;
}

/**
 * Said at the first HTML file, to those who had Previewix before it opened them: until then a click on such
 * a file gave them its text, and they were told about the choice of file types when that was not among them.
 */
export function introduceHtml(context: vscode.ExtensionContext): void {
  if (!context.globalState.get(INTRODUCED_HTML)) {
    void context.globalState.update(INTRODUCED_HTML, true);
    introduce('Previewix now opens HTML files as the rendered page; "Open source" in its toolbar leads to the text. You can choose which file types it handles.');
  }
}
