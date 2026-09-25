import { createAcpBridge } from './acp-bridge.js';
export function isChatSessionsAvailable(vscode: any): boolean {
  return typeof vscode?.chat?.createChatSessionItemController === 'function'
    && typeof vscode?.chat?.registerChatSessionContentProvider === 'function';
}
export function registerOpencodeChatSession(vscode: any, outputChannel: { appendLine(m: string): void }, bridge = createAcpBridge()) {
  if (!isChatSessionsAvailable(vscode)) throw new Error('chatSessionsProvider API not available (Insiders proposed API required)');
  const controller = vscode.chat.createChatSessionItemController('opencode', async () => {
    try {
      const sessions = await bridge.listSessions();
      controller.items.replace(sessions.map((s: any) => controller.createChatSessionItem(vscode.Uri.parse(s.resource), s.label)));
    } catch (err) {
      outputChannel.appendLine(`[opencode] refresh failed: ${err}`);
    }
  });
  controller.newChatSessionItemHandler = async (ctx: any) => {
    const cwd = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
    const s = await bridge.newSession(cwd);
    const item = controller.createChatSessionItem(vscode.Uri.parse(s.resource), s.label);
    // The editor adds the returned item to the collection itself; only add
    // explicitly when the collection API supports it (older mocks key by string).
    try {
      const items: any = controller.items;
      if (typeof items?.add === 'function') items.add(item);
      else if (typeof items?.set === 'function') items.set(s.resource, item);
    } catch (err) {
      outputChannel.appendLine(`[opencode] items add skipped: ${err}`);
    }
    if (ctx?.request?.prompt) await bridge.prompt(s.resource, ctx.request.prompt);
    return item;
  };
  const contentDisp = vscode.chat.registerChatSessionContentProvider('opencode', {
    async provideChatSessionContent(resource: any, _token: any, _ctx: any) {
      const prompt = String(resource?.toString?.() ?? '');
      // History items must be ChatResponseTurn instances: the extension host
      // routes non-ChatRequestTurn items through convertResponseTurn, which
      // reads turn.response.map. Plain {role, content} objects crash it.
      const PartCtor: any = (vscode as any).ChatResponseMarkdownPart
        ?? class { value: unknown; constructor(value: unknown) { this.value = value; } };
      const TurnCtor: any = (vscode as any).ChatResponseTurn;
      const part = new PartCtor(`OpenCode ready: ${prompt}`);
      const turn = TurnCtor
        ? new TurnCtor([part], {}, 'opencode', undefined)
        : { response: [part], result: {}, participant: 'opencode' };
      // Interactive handler: echo the user prompt back as markdown while the
      // real ACP streaming bridge lands. requestHandler present (not undefined)
      // marks the session writeable instead of read-only.
      const requestHandler = async (request: any, _context: any, response: any, _token: any) => {
        const text = String(request?.prompt ?? '');
        await bridge.prompt(String(resource?.toString?.() ?? ''), text);
        try {
          response?.markdown?.(`OpenCode echo (stub, ACP streaming next): ${text}`);
        } catch (err) {
          outputChannel.appendLine(`[opencode] response stream failed: ${err}`);
        }
        return {};
      };
      return { title: 'OpenCode', history: [turn], requestHandler };
    },
  });
  outputChannel.appendLine('[opencode] chatSessions controller registered for type opencode');
  return { dispose() { try { controller.dispose(); } catch {} try { contentDisp.dispose(); } catch {} try { bridge.dispose(); } catch {} } };
}
