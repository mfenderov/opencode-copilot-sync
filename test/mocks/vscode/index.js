export class EventEmitter {
  #listeners = new Set();
  event = (listener) => {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  };
  fire(data) {
    for (const listener of this.#listeners) {
      try {
        listener(data);
      } catch {}
    }
  }
}
export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
export class LanguageModelTextPart { constructor(value) { this.value = value; } }
export class LanguageModelToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
export class LanguageModelToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }
export class LanguageModelThinkingPart { constructor(value, id) { this.value = value; this.id = id; } }
export class LanguageModelError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LanguageModelError';
    this.code = code;
  }
  static NoPermissions(message) {
    return new LanguageModelError(message, 'NoPermissions');
  }
  static NotFound(message) {
    return new LanguageModelError(message, 'NotFound');
  }
  static Blocked(message) {
    return new LanguageModelError(message, 'Blocked');
  }
}
export const window = {
  createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {} }),
};
export const lm = {
  registerLanguageModelChatProvider: () => ({ dispose: () => {} }),
};
