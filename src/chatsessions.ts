import { createAcpBridge } from './acp-bridge.js';
export function registerOpencodeChatSession(vscode: any, outputChannel: { appendLine(m: string): void }, bridge = createAcpBridge()) {
  const controller = vscode.chat.createChatSessionItemController('opencode', async () => {
    const sessions = await bridge.listSessions();
    controller.items.replace(sessions.map((s: any) => controller.createChatSessionItem(vscode.Uri.parse(s.resource), s.label)));
  });
  controller.newChatSessionItemHandler = async (ctx: any) => {
    const cwd = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
    const s = await bridge.newSession(cwd);
    const item = controller.createChatSessionItem(vscode.Uri.parse(s.resource), s.label);
    (controller.items as Map<string, unknown>).set(s.resource, item);
    if (ctx?.request?.prompt) await bridge.prompt(s.resource, ctx.request.prompt);
    return item;
  };
  const contentDisp = vscode.chat.registerChatSessionContentProvider('opencode', {
    async provideChatSessionContent(resource: any, _token: any, _ctx: any) {
      const prompt = String(resource?.toString?.() ?? '');
      return { title: 'OpenCode', history: [{ role: 'assistant', content: `OpenCode ready: ${prompt}` }] };
    },
  });
  outputChannel.appendLine('[opencode] chatSessions controller registered for type opencode');
  return { dispose() { try { controller.dispose(); } catch {} try { contentDisp.dispose(); } catch {} try { bridge.dispose(); } catch {} } };
}
