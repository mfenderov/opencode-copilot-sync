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
  // Canonicalize a VS Code-side resource to the ACP sessionId for the
  // extension-side selection map. The resource string changes identity over
  // the session lifetime (untitled placeholder -> opencode:// resource), so
  // key by the stable tail (acpSid) as well as the full string.
  function xcanon(resourceStr: string): string {
    const tail = String(resourceStr ?? '').split('/').pop() ?? resourceStr;
    return tail || resourceStr;
  }
  // Server truth for the status pickers: the session's actual current values
  // as reported by ACP configOptions. No local overrides — the server ignores
  // switching params, so anything we store locally would be a lie.
  function selFor(resourceStr: string): { model?: string; effort?: string; mode?: string } {
    return {
      model: b.getSessionModel?.(resourceStr),
      effort: b.getSessionConfig?.(resourceStr)?.effort,
      mode: b.getSessionConfig?.(resourceStr)?.mode,
    };
  }
  function applySel(resourceStr: string, cfg: { model?: string; effort?: string; mode?: string }): void {
    // Recorded for diagnostics only; the v2.0.16 server ignores these params.
    // Kept so the plumbing exists when the server starts honoring them.
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
  // Honest single-item group: opencode ACP v2.0.16 ignores per-prompt and
  // per-session model/mode params server-side (verified by behavioral probes:
  // pinned model/mode never change the answering model). Show the session's
  // ACTUAL current value as read-only status instead of a fake control.
  // Per-context model control today = opencode config files, not ACP params.
  function statusGroupFor(id: string, name: string, currentValue: string | undefined, serverNote: string): any {
    if (!currentValue) return undefined;
    return {
      id, name,
      description: `${serverNote} (server default — switching not supported by opencode ACP v2.0.16)`,
      selected: { id: currentValue, name: currentValue, default: true, locked: true },
      items: [{ id: currentValue, name: currentValue, description: serverNote, default: true, locked: true }],
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
    // Order: Mode status first, then Model status (mirrors Agent/Model row).
    // Single-item + locked: the server ignores switching params, so the only
    // honest UI is the session's actual current values as read-only status.
    const md = statusGroupFor('mode', 'Mode', currentMode, 'session mode');
    if (md) out.push(md);
    const mg = statusGroupFor('models', 'Model', currentModel, 'session model');
    if (mg) { if (out.length < 2) out.push(mg); }
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
    // NOTE: ctx.inputState may be absent here (handler runs pre-input-state)
    // — the bridge seeds sessionModels from the server currentValue, and the
    // per-message requestHandler re-reads the picker. This block only applies
    // an explicit user pick when one is actually present.
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
      if (cfg.model || cfg.effort || cfg.mode) {
        outputChannel.appendLine(`[opencode] new-session picks: ${JSON.stringify(cfg)}`);
        applySel(s.resource, cfg);
      }
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
        // Re-read the pickers' current selection. IMPORTANT: only apply when
        // the context actually carries a selection — the inputState shape
        // varies by surface (Agents panel vs Chat view) and an absent/empty
        // selection must NOT overwrite the per-session value with a default.
        // Observed misroute: Space Bunny selected, prompt went out as GPT Luna.
        try {
          const groups: any[] = context?.inputState?.groups ?? context?.history?.inputState?.groups ?? [];
          const pick = (id: string): string | undefined => {
            const g = groups.find?.((x: any) => x?.id === id);
            if (!g) return undefined;
            // selected may be an item {id}, a bare id string, or a Map-like.
            const s = g?.selected;
            const vid = typeof s === 'string' ? s : (s as any)?.id;
            return typeof vid === 'string' && vid ? vid : undefined;
          };
          const cfg: { model?: string; effort?: string; mode?: string } = {
            model: pick('models'), effort: pick('effort'), mode: pick('mode'),
          };
          if (cfg.model || cfg.effort || cfg.mode) {
            outputChannel.appendLine(`[opencode] per-message picks: ${JSON.stringify(cfg)}`);
            applySel(resourceStr, cfg);
          }
        } catch (err) {
          outputChannel.appendLine(`[opencode] option apply skipped: ${err}`);
        }
        const cancelled = { cancelled: false };
        const onCancel = () => { cancelled.cancelled = true; };
        try { token?.onCancellationRequested?.(onCancel); } catch { /* ignore */ }
        try {
          let first = true;
          const selEcho = selFor(resourceStr);
          outputChannel.appendLine(`[opencode] prompt model=${selEcho.model ?? '<server-default>'} effort=${selEcho.effort ?? '-'} mode=${selEcho.mode ?? '-'}`);
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
