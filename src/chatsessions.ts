import { createAcpBridge } from './acp-bridge.js';
export function isChatSessionsAvailable(vscode: any): boolean {
  return typeof vscode?.chat?.createChatSessionItemController === 'function'
    && typeof vscode?.chat?.registerChatSessionContentProvider === 'function';
}
export function registerOpencodeChatSession(vscode: any, outputChannel: { appendLine(m: string): void }, bridge = createAcpBridge()) {
  if (!isChatSessionsAvailable(vscode)) throw new Error('chatSessionsProvider API not available (Insiders proposed API required)');
  type Bridge = ReturnType<typeof createAcpBridge>;
  const b = bridge as Bridge & { getModels?: () => Promise<{ models: { value: string; name: string }[]; current?: string }>; getSessionModel?: (h: string) => string | undefined; setSessionModel?: (h: string, m: string) => void };
  // Per-session model selection shown in the agent input pickers. Resolved
  // lazily from the ACP session/new configOptions (108 models).
  const sessionModelSel = new Map<string, string>();
  async function modelGroupFor(resourceStr: string) {
    let items: { value: string; name: string }[] = [];
    let current: string | undefined = sessionModelSel.get(resourceStr) ?? b.getSessionModel?.(resourceStr);
    try {
      const got = await b.getModels?.();
      if (got?.models?.length) {
        items = got.models;
        current ??= got.current;
      }
    } catch (err) {
      outputChannel.appendLine(`[opencode] models fetch failed: ${err}`);
    }
    if (!items.length) return undefined;
    current ??= items[0].value;
    const selected = items.find(i => i.value === current) ?? items[0];
    return {
      id: 'models', name: 'Model', description: 'OpenCode model for this session',
      selected: { id: selected.value, name: selected.name, default: true },
      items: items.map(i => ({ id: i.value, name: i.name, default: i.value === selected.value })),
    };
  }
  const controller = vscode.chat.createChatSessionItemController('opencode', async () => {
    try {
      const sessions = await b.listSessions();
      controller.items.replace(sessions.map((s: any) => controller.createChatSessionItem(vscode.Uri.parse(s.resource), s.label)));
    } catch (err) {
      outputChannel.appendLine(`[opencode] refresh failed: ${err}`);
    }
  });
  // Model picker in the agent input: VS Code queries this for option groups.
  (controller as any).getChatSessionInputState = async (sessionResource: any, ctx: any) => {
    const resourceStr = String(sessionResource?.toString?.() ?? ctx?.previousInputState?.sessionResource?.toString?.() ?? '');
    const group: any = await modelGroupFor(resourceStr);
    const groups = group ? [group] : [];
    try {
      return (controller as any).createChatSessionInputState
        ? (controller as any).createChatSessionInputState(groups)
        : { groups, sessionResource, onDidDispose: { dispose() {} }, onDidChange: { event: () => ({ dispose() {} }) } };
    } catch {
      return { groups };
    }
  };
  controller.newChatSessionItemHandler = async (ctx: any) => {
    const cwd = vscode.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
    const s = await b.newSession(cwd);
    // Honor the model picked in the input state, if the user chose one.
    try {
      const sel = ctx?.inputState?.groups?.find?.((g: any) => g?.id === 'models')?.selected?.id
        ?? ctx?.inputState?.groups?.[0]?.selected?.id;
      if (typeof sel === 'string' && sel) {
        sessionModelSel.set(s.resource, sel);
        b.setSessionModel?.(s.resource, sel);
      }
    } catch (err) {
      outputChannel.appendLine(`[opencode] model select skipped: ${err}`);
    }
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
    if (ctx?.request?.prompt) await b.prompt(s.resource, ctx.request.prompt);
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
      // Interactive handler: stream the prompt through the real ACP bridge.
      // Falls back to an explanatory note if the harness is unreachable.
      const requestHandler = async (request: any, context: any, response: any, token: any) => {
        const text = String(request?.prompt ?? '');
        const resourceStr = String(resource?.toString?.() ?? '');
        // Model picked per message via the input-state picker, if present.
        try {
          const groups: any[] = context?.inputState?.groups ?? context?.history?.inputState?.groups ?? [];
          const sel = groups.find?.((g: any) => g?.id === 'models')?.selected?.id;
          const selId = typeof sel === 'string' ? sel : (sel as any)?.id;
          if (typeof selId === 'string' && selId) {
            sessionModelSel.set(resourceStr, selId);
            b.setSessionModel?.(resourceStr, selId);
          }
        } catch (err) {
          outputChannel.appendLine(`[opencode] model apply skipped: ${err}`);
        }
        const cancelled = { cancelled: false };
        const onCancel = () => { cancelled.cancelled = true; };
        try { token?.onCancellationRequested?.(onCancel); } catch { /* ignore */ }
        try {
          let first = true;
          const full = await b.prompt(resourceStr, text, (chunk) => {
            try {
              if (first) { response?.progress?.('OpenCode is thinking…'); first = false; }
              response?.markdown?.(chunk);
            } catch (err) {
              outputChannel.appendLine(`[opencode] response stream failed: ${err}`);
            }
          }, cancelled);
          if (!full) response?.markdown?.('(OpenCode returned no text for this prompt.)');
        } catch (err) {
          outputChannel.appendLine(`[opencode] prompt failed: ${err}`);
          response?.markdown?.(`OpenCode harness error: ${err instanceof Error ? err.message : String(err)}`);
        }
        return {};
      };
      return { title: 'OpenCode', history: [turn], requestHandler };
    },
  });
  outputChannel.appendLine('[opencode] chatSessions controller registered for type opencode');
  return { dispose() { try { controller.dispose(); } catch {} try { contentDisp.dispose(); } catch {} try { b.dispose(); } catch {} } };
}
