const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new TodoCustomEditorProvider(context);
  context.subscriptions.push(TodoCustomEditorProvider.register(context, provider));
}

class TodoCustomEditorProvider {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {TodoCustomEditorProvider} provider
   */
  static register(context, provider) {
    return vscode.window.registerCustomEditorProvider(
      'todo-plus-plus.editor',
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    );
  }

  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.editQueue = Promise.resolve();
  }

  queueEdit(operation) {
    this.editQueue = this.editQueue.then(async () => {
      try {
        await operation();
      } catch (err) {
        console.error('Error executing queued edit:', err);
      }
    });
    return this.editQueue;
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.WebviewPanel} webviewPanel
   * @param {vscode.CancellationToken} token
   */
  async resolveCustomTextEditor(document, webviewPanel, token) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(this.context.extensionPath)
      ]
    };

    // Attempt to set tab icon (supported in some VS Code environments, fallback to theme defaults)
    webviewPanel.iconPath = vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'icon.png'));

    // Check if the document is empty and initialize it with a default task if so
    if (document.getText().trim() === '') {
      const defaultText = this.updateLineMetadata("- [ ] ", true);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), defaultText);
      await this.applyEditAndSave(document, edit);
    }

    // Initialize metadata for any lines missing it
    const text = document.getText();
    const lines = text.split('\n');
    let hasChanges = false;
    const updatedLines = lines.map(line => {
      const updatedLine = this.initializeMetadataIfMissing(line);
      if (updatedLine !== line) {
        hasChanges = true;
      }
      return updatedLine;
    });

    if (hasChanges) {
      const lastLine = document.lineAt(document.lineCount - 1);
      const entireRange = new vscode.Range(0, 0, document.lineCount - 1, lastLine.text.length);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, entireRange, updatedLines.join('\n'));
      await this.applyEditAndSave(document, edit);
    }

    // Load initial HTML
    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Initial load message
    webviewPanel.webview.postMessage({
      type: 'update',
      text: document.getText()
    });

    // Update document subscription
    const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) {
        webviewPanel.webview.postMessage({
          type: 'update',
          text: document.getText()
        });
      }
    });

    webviewPanel.onDidDispose(() => {
      changeDocumentSubscription.dispose();
    });

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(async message => {
      switch (message.type) {
        case 'toggle':
          this.queueEdit(() => this.toggleCheckbox(document, message.lineIndex, message.newState, message.text));
          break;
        case 'editLine':
          this.queueEdit(() => this.editLineText(document, message.lineIndex, message.text));
          break;
        case 'makeHeader':
          this.queueEdit(() => this.makeLineHeader(document, message.lineIndex, message.text));
          break;
        case 'newLine':
          this.queueEdit(() => this.insertNewLine(document, message.lineIndex, message.text));
          break;
        case 'indentLine':
          this.queueEdit(() => this.indentLine(document, message.lineIndex, message.text, message.direction));
          break;
        case 'deleteLine':
          this.queueEdit(() => this.deleteLine(document, message.lineIndex));
          break;
        case 'deleteLines':
          this.queueEdit(() => this.deleteMultipleLines(document, message.lineIndices));
          break;
        case 'undo':
          await vscode.commands.executeCommand('undo');
          break;
        case 'redo':
          await vscode.commands.executeCommand('redo');
          break;
        case 'ready':
          webviewPanel.webview.postMessage({
            type: 'update',
            text: document.getText()
          });
          break;
        case 'openRaw':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
      }
    });
  }

  /**
   * @param {vscode.Webview} webview
   * @returns {string}
   */
  getHtmlForWebview(webview) {
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'webview.css')));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'webview.js')));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Todo++</title>
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="app">
    <div class="app-header">
      <button class="header-btn" title="Add Header">Add Header</button>
      <button class="raw-btn" title="Open Raw Markdown">Edit Raw</button>
    </div>
    <div id="tasks-container">
      <div class="loader">Loading tasks...</div>
    </div>
  </div>
  <script src="${jsUri}"></script>
</body>
</html>`;
  }

  /**
   * Helper to perform document edits and auto-save.
   */
  async applyEditAndSave(document, edit) {
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} lineIndex
   * @param {string} newState
   * @param {string|null} text
   */
  async toggleCheckbox(document, lineIndex, newState, text = null) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) return;
    const line = document.lineAt(lineIndex);
    const lineText = line.text;
    const regex = /^(\s*[-*]\s+\[)([\s/?x])(\])/;
    
    let baseText = lineText;
    if (text !== null) {
      // Reconstruct line with new text, preserving prefix formatting
      const cleanLineText = lineText.replace(/\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/, '');
      const prefixRegex = /^(\s*[-*]\s+\[[\s/?x]\]\s*)/;
      const match = cleanLineText.match(prefixRegex);
      const prefix = match ? match[0] : '';
      baseText = prefix + text;
    }
    
    let newText = baseText.replace(regex, (match, p1, p2, p3) => {
      let char = ' ';
      if (newState === 'doubt') char = '?';
      else if (newState === 'in-progress') char = '/';
      else if (newState === 'completed') char = 'x';
      return p1 + char + p3;
    });

    // Update created/updated timestamps
    newText = this.updateLineMetadata(newText);

    const range = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, newText);
    await this.applyEditAndSave(document, edit);
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} lineIndex
   * @param {string} text
   */
  async editLineText(document, lineIndex, text) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) return;
    const line = document.lineAt(lineIndex);
    const lineText = line.text;

    // Strip metadata comments before processing prefixes
    const cleanLineText = lineText.replace(/\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/, '');

    // Matches bullet item prefix, header prefix, or leading whitespace
    const regex = /^(\s*[-*]\s+\[[\s/?x]\]\s*|\s*[-*]\s+|#{1,6}\s+|\s*)/;
    const match = cleanLineText.match(regex);
    const prefix = match ? match[0] : '';
    let newText = prefix + text;

    // Update created/updated timestamps
    newText = this.updateLineMetadata(newText);

    const range = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, newText);
    await this.applyEditAndSave(document, edit);
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} lineIndex
   * @param {string} text
   */
  async makeLineHeader(document, lineIndex, text) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) return;
    const line = document.lineAt(lineIndex);
    const lineText = line.text;

    const newText = `# ${text}`;

    const range = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, newText);
    await this.applyEditAndSave(document, edit);
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} lineIndex
   * @param {string} text
   */
  async insertNewLine(document, lineIndex, text) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) return;
    const line = document.lineAt(lineIndex);
    const lineText = line.text;

    // 1. Get the current line text, strip metadata comments, and apply the new text
    const cleanLineText = lineText.replace(/\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/, '');
    const prefixRegex = /^(\s*[-*]\s+\[[\s/?x]\]\s*|\s*[-*]\s+|#{1,6}\s+|\s*)/;
    const match = cleanLineText.match(prefixRegex);
    const prefix = match ? match[0] : '';
    let updatedCurrentLineText = prefix + text;
    updatedCurrentLineText = this.updateLineMetadata(updatedCurrentLineText);

    // 2. Generate the new empty line text with metadata (inheriting list prefix type)
    let newLineText = '';
    const checkboxRegex = /^(\s*[-*]\s+\[)([\s/?x])(\])(\s*)/;
    const bulletRegex = /^(\s*[-*]\s+)/;
    const headerRegex = /^#{1,6}\s+/;
    const indentRegex = /^(\s*)/;

    if (checkboxRegex.test(prefix)) {
      const matchPrefix = prefix.match(checkboxRegex);
      newLineText = matchPrefix[1] + ' ' + matchPrefix[3] + ' ';
    } else if (bulletRegex.test(prefix)) {
      newLineText = prefix.match(bulletRegex)[1];
    } else if (headerRegex.test(prefix)) {
      newLineText = '- [ ] ';
    } else {
      newLineText = prefix.match(indentRegex)[1];
    }
    newLineText = this.updateLineMetadata(newLineText, true);

    // 3. Apply both edits (updating current line + inserting new line) in a single transaction
    const edit = new vscode.WorkspaceEdit();
    // Replace the current line
    const currentLineRange = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
    edit.replace(document.uri, currentLineRange, updatedCurrentLineText);
    // Insert the new line after it
    const position = new vscode.Position(lineIndex, lineText.length);
    edit.insert(document.uri, position, '\n' + newLineText);

    await this.applyEditAndSave(document, edit);
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} lineIndex
   * @param {string} text
   * @param {'in'|'out'} direction
   */
  async indentLine(document, lineIndex, text, direction) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) return;
    const line = document.lineAt(lineIndex);
    const lineText = line.text;

    // 1. Get the current line text, strip metadata comments, and apply the new text
    const cleanLineText = lineText.replace(/\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/, '');

    // Headers cannot be indented
    if (/^\s*#{1,6}\s+/.test(cleanLineText)) return;

    const prefixRegex = /^(\s*[-*]\s+\[[\s/?x]\]\s*|\s*[-*]\s+|#{1,6}\s+|\s*)/;
    const match = cleanLineText.match(prefixRegex);
    const prefix = match ? match[0] : '';
    let updatedText = prefix + text;

    // 2. Apply indentation shift
    if (direction === 'in') {
      updatedText = '  ' + updatedText;
    } else if (direction === 'out') {
      if (updatedText.startsWith('  ')) {
        updatedText = updatedText.substring(2);
      } else if (updatedText.startsWith(' ')) {
        updatedText = updatedText.substring(1);
      }
    }

    // 3. Update metadata
    updatedText = this.updateLineMetadata(updatedText);

    const range = new vscode.Range(lineIndex, 0, lineIndex, lineText.length);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, updatedText);
    await this.applyEditAndSave(document, edit);
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number} lineIndex
   */
  async deleteLine(document, lineIndex) {
    if (lineIndex < 0 || lineIndex >= document.lineCount) return;
    const line = document.lineAt(lineIndex);
    const edit = new vscode.WorkspaceEdit();

    let range;
    if (lineIndex === document.lineCount - 1 && lineIndex > 0) {
      const prevLine = document.lineAt(lineIndex - 1);
      range = new vscode.Range(lineIndex - 1, prevLine.text.length, lineIndex, line.text.length);
    } else {
      range = new vscode.Range(lineIndex, 0, lineIndex + 1, 0);
    }

    edit.delete(document.uri, range);
    await this.applyEditAndSave(document, edit);

    if (document.getText().trim() === '') {
      const defaultText = this.updateLineMetadata("- [ ] ", true);
      const insertEdit = new vscode.WorkspaceEdit();
      insertEdit.insert(document.uri, new vscode.Position(0, 0), defaultText);
      await this.applyEditAndSave(document, insertEdit);
    }
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {number[]} lineIndices
   */
  async deleteMultipleLines(document, lineIndices) {
    const edit = new vscode.WorkspaceEdit();
    // Indices must be processed in descending order to prevent shifting ranges!
    const sortedIndices = [...lineIndices].sort((a, b) => b - a);
    
    sortedIndices.forEach(lineIndex => {
      if (lineIndex < 0 || lineIndex >= document.lineCount) return;
      const line = document.lineAt(lineIndex);
      let range;
      if (lineIndex === document.lineCount - 1 && lineIndex > 0) {
        const prevLine = document.lineAt(lineIndex - 1);
        range = new vscode.Range(lineIndex - 1, prevLine.text.length, lineIndex, line.text.length);
      } else {
        range = new vscode.Range(lineIndex, 0, lineIndex + 1, 0);
      }
      edit.delete(document.uri, range);
    });
    
    await this.applyEditAndSave(document, edit);

    if (document.getText().trim() === '') {
      const defaultText = this.updateLineMetadata("- [ ] ", true);
      const insertEdit = new vscode.WorkspaceEdit();
      insertEdit.insert(document.uri, new vscode.Position(0, 0), defaultText);
      await this.applyEditAndSave(document, insertEdit);
    }
  }

  /**
   * Updates or inserts metadata comments (created & updated timestamps) on a line.
   * Keeps headers (#) and empty lines clean.
   */
  updateLineMetadata(lineText, isNew = false) {
    const nowStr = this.getTimestamp();
    const metaRegex = /\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/;
    const match = lineText.match(metaRegex);
    
    let created = nowStr;
    let updated = nowStr;
    let baseText = lineText;
    
    if (match) {
      created = match[1];
      updated = nowStr;
      baseText = lineText.replace(metaRegex, '');
    } else if (!isNew) {
      created = nowStr;
      updated = nowStr;
    }
    
    // Do not add metadata comments to headers or empty/whitespace-only lines
    if (baseText.trim().startsWith('#') || baseText.trim() === '') {
      return baseText;
    }
    
    return `${baseText} <!-- c: ${created}, u: ${updated} -->`;
  }

  /**
   * Initializes created and updated metadata comments on a line if they are missing.
   * Keeps headers (#) and empty lines clean.
   */
  initializeMetadataIfMissing(lineText) {
    const metaRegex = /\s*<!--\s*c:\s*([\d- :]+),\s*u:\s*([\d- :]+)\s*-->$/;
    
    // If it already has metadata, leave it untouched
    if (metaRegex.test(lineText)) {
      return lineText;
    }
    
    // Do not add metadata comments to headers or empty/whitespace-only lines
    if (lineText.trim().startsWith('#') || lineText.trim() === '') {
      return lineText;
    }
    
    const nowStr = this.getTimestamp();
    return `${lineText} <!-- c: ${nowStr}, u: ${nowStr} -->`;
  }

  /**
   * Gets current date & time string in format YYYY-MM-DD HH:mm
   */
  getTimestamp() {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${YYYY}-${MM}-${DD} ${HH}:${mm}`;
  }
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
