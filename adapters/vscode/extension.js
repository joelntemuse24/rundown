// Iframes /r/:id from the configured Rundown server. All logic stays in the server.
const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('rundown.open', async () => {
      const server = vscode.workspace.getConfiguration('rundown').get('url').replace(/\/+$/, '');
      const input = await vscode.window.showInputBox({ prompt: 'Replay URL or id', placeHolder: `${server}/r/0123456789ab` });
      if (!input) return;
      const url = /^https?:\/\//.test(input) ? input : `${server}/r/${input.trim()}`;
      const origin = new URL(url).origin;
      const panel = vscode.window.createWebviewPanel('rundown', 'Rundown', vscode.ViewColumn.Active, { enableScripts: true });
      panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin};"><style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100vh}</style></head><body><iframe src="${url}"></iframe></body></html>`;
    }),
  );
}

module.exports = { activate, deactivate() {} };
