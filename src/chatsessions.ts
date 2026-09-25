import { createAcpBridge } from './acp-bridge.js';
export function isChatSessionsAvailable(vscode: any): boolean {
  return typeof vscode?.chat?.createChatSessionItemController === 'function'
    && typeof vscode?.chat?.registerChatSessionContentProvider === 'function';
}
export function registerOpencodeChatSession(vscode: any, outputChannel: { appendLine(m: string): void }, bridge = createAcpBridge()) {
  if (!isChatSessionsAvailable(vscode)) throw new Error('chatSessionsProvider API not available (Insiders proposed API required)');
  type Bridge = ReturnType<typeof createAcpBridge>;
  const b = bridge as Bridge & {
    getModels?: () => Promise<{ models: { value: string; name: string }[]; current?: string }>;
    getConfig?: () => Promise<{ models: { value: string; name: string }[]; currentModel?: string; efforts: { value: string; name: string }[]; currentEffort?: string; modes: { value: string; name: string }[]; currentMode?: string }>;
    getSessionModel?: (h: string) => string | undefined;
    setSessionModel?: (h: string, m: string) => void;
    getSessionConfig?: (h: string) => { model?: string; effort?: string; mode?: string };
    setSessionConfig?: (h: string, c: { model?: string; effort?: string; mode?: string }) => void;
  };
  // Per-session selections shown in the agent input pickers (Model, Effort,
  // Mode). Resolved lazily from the ACP session/new configOptions.
  const sessionSel = new Map<string, { model?: string; effort?: string; mode?: string }>();
  function selFor(resourceStr: string): { model?: string; effort?: string; mode?: string } {
    return {
      model: sessionSel.get(resourceStr)?.model ?? b.getSessionModel?.(resourceStr),
      effort: sessionSel.get(resourceStr)?.effort ?? b.getSessionConfig?.(resourceStr)?.effort,
      mode: sessionSel.get(resourceStr)?.mode ?? b.getSessionConfig?.(resourceStr)?.mode,
    };
  }
  function applySel(resourceStr: string, cfg: { model?: string; effort?: string; mode?: string }): void {
    const prev = sessionSel.get(resourceStr) ?? {};
    sessionSel.set(resourceStr, { ...prev, ...cfg });
    b.setSessionConfig?.(resourceStr, cfg);
    if (cfg.model) b.setSessionModel?.(resourceStr, cfg.model);
  }
  function groupFor(id: string, name: string, description: string, options: { value: string; name: string }[], current?: string): any {
    if (!options.length) return undefined;
    const sel = options.find(o => o.value === current) ?? options[0];
    const cap = (s: string) => s.length > 60 ? s.slice(0, 57) + '…' : s;
    return {
      id, name, description,
      selected: { id: sel.value, name: sel.name, default: true },
      items: options.map(o => ({ id: o.value, name: cap(o.name), description: o.value, tooltip: o.value, default: o.value === sel.value })),
    };
  }
  async function optionGroupsFor(resourceStr: string): Promise<any[]> {
    const sel = selFor(resourceStr);
    let models: { value: string; name: string }[] = [];
    let efforts: { value: string; name: string }[] = [];
    let modes: { value: string; name: string }[] = [];
    let currentModel = sel.model;
    let currentEffort = sel.effort;
    let currentMode = sel.mode;
    try {
      const cfg = await b.getConfig?.();
      if (cfg) {
        // NOTE: max 2 groups supported by the API; prefer models + mode.
        if (cfg.models?.length) { models = cfg.models; currentModel ??= cfg.currentModel; }
        if (cfg.modes?.length) { modes = cfg.modes; currentMode ??= cfg.currentMode; }
        if (cfg.efforts?.length) { efforts = cfg.efforts; currentEffort ??= cfg.currentEffort; }
      }
      if (!models.length) {
        const got = await b.getModels?.();
        if (got?.models?.length) { models = got.models; currentModel ??= got.current; }
      }
    } catch (err) {
      outputChannel.appendLine(`[opencode] config fetch failed: ${err}`);
    }
    const out: any[] = [];
    // Log once per registration so the Output channel proves the round-trip.
    outputChannel.appendLine(`[opencode] option groups for ${resourceStr || '<new>'}: models=${models.length} modes=${modes.length} efforts=${efforts.length}`);
    // Order: Mode first, then Model (like the Agent/Model reading order).
    const md = groupFor('mode', 'Mode', 'Build or Plan', modes, currentMode);
    if (md) out.push(md);
    const mg = groupFor('models', 'Model', 'OpenCode model for this session', models, currentModel);
    if (mg) { if (out.length < 2) out.push(mg); }
    if (out.length < 2) {
      const eg = groupFor('effort', 'Effort', 'Reasoning effort', efforts, currentEffort);
      if (eg) out.push(eg);
    }
    return out.slice(0, 2);
  }
  const controller = vscode.chat.createChatSessionItemController('opencode', async () => {
    try {
      const sessions = await b.listSessions();
      controller.items.replace(sessions.map((s: any) => controller.createChatSessionItem(vscode.Uri.parse(s.resource), s.label)));
    } catch (err) {
      outputChannel.appendLine(`[opencode] refresh failed: ${err}`);
    }
  });
  // Option groups for the agent input pickers. VS Code queries this for
  // per-session input state; the content provider answers type-level groups.
  (controller as any).getChatSessionInputState = async (sessionResource: any, ctx: any) => {
    const resourceStr = String(sessionResource?.toString?.() ?? ctx?.previousInputState?.sessionResource?.toString?.() ?? '');
    const groups = await optionGroupsFor(resourceStr);
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
    // Honor options picked in the input state, if the user chose any.
    try {
      const groups: any[] = ctx?.inputState?.groups ?? [];
      const pick = (id: string): string | undefined => {
        const g = groups.find?.((x: any) => x?.id === id);
        const v = g?.selected?.id;
        return typeof v === 'string' ? v : undefined;
      };
      const cfg: { model?: string; effort?: string; mode?: string } = {
        model: pick('models'), effort: pick('effort'), mode: pick('mode'),
      };
      if (cfg.model || cfg.effort || cfg.mode) applySel(s.resource, cfg);
    } catch (err) {
      outputChannel.appendLine(`[opencode] option select skipped: ${err}`);
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
    provideHandleOptionsChange: ((resource: any, updates: any) => {
      const resourceStr = String(resource?.toString?.() ?? '');
      const cfg: { model?: string; effort?: string; mode?: string } = {};
      for (const u of updates ?? []) {
        const id = (u as any)?.optionId ?? (u as any)?.id;
        const val = (u as any)?.value;
        const valId = typeof val === 'string' ? val : (val as any)?.id;
        if (typeof valId !== 'string' || !valId) continue;
        if (id === 'models') cfg.model = valId;
        else if (id === 'effort') cfg.effort = valId;
        else if (id === 'mode') cfg.mode = valId;
      }
      if (cfg.model || cfg.effort || cfg.mode) {
        applySel(resourceStr, cfg);
        outputChannel.appendLine(`[opencode] options selected: ${JSON.stringify(cfg)}`);
      }
    }) as any,
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
        // Options picked per message via the input-state pickers, if present.
        try {
          const groups: any[] = context?.inputState?.groups ?? context?.history?.inputState?.groups ?? [];
          const pick = (id: string): string | undefined => {
            const g = groups.find?.((x: any) => x?.id === id);
            const v = g?.selected?.id ?? g?.selected;
            const vid = typeof v === 'string' ? v : (v as any)?.id;
            return typeof vid === 'string' ? vid : undefined;
          };
          const cfg: { model?: string; effort?: string; mode?: string } = {
            model: pick('models'), effort: pick('effort'), mode: pick('mode'),
          };
          if (cfg.model || cfg.effort || cfg.mode) applySel(resourceStr, cfg);
        } catch (err) {
          outputChannel.appendLine(`[opencode] option apply skipped: ${err}`);
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
    // Type-level provider options: VS Code renders these as the input-bar
    // pickers (Model, Mode). Called with no session context; per-session
    // values come from session/new configOptions + inputState.
    provideChatSessionProviderOptions: (async (_token: any) => {
      try {
        const groups = await optionGroupsFor('');
        if (!groups.length) return {};
        const selected: Record<string, string> = {};
        for (const g of groups) {
          if (g?.selected?.id) selected[g.id] = g.selected.id;
        }
        outputChannel.appendLine(`[opencode] provider options served: ${groups.map((g: any) => `${g.id}=${g.items.length}`).join(', ')}`);
        return { optionGroups: groups, newSessionOptions: selected };
      } catch (err) {
        outputChannel.appendLine(`[opencode] provider options failed: ${err}`);
        return {};
      }
    }) as any,
  });
  outputChannel.appendLine('[opencode] chatSessions controller registered for type opencode');
  return { dispose() { try { controller.dispose(); } catch {} try { contentDisp.dispose(); } catch {} try { b.dispose(); } catch {} } };
}
