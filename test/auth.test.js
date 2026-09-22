import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiKey, promptAndSetApiKey, SECRET_KEY } from '../out/auth.js';
import * as vscode from 'vscode';

function createMockSecretStorage(initialKey = '') {
  const store = new Map();
  if (initialKey) {
    store.set(SECRET_KEY, initialKey);
  }
  return {
    get: async (key) => store.get(key),
    store: async (key, val) => {
      store.set(key, val);
    },
    delete: async (key) => {
      store.delete(key);
    },
    raw: store,
  };
}

test('resolveApiKey returns stored key from SecretStorage without disk scanning', async () => {
  const secrets = createMockSecretStorage('sk-stored-vault-key-12345');
  const key = await resolveApiKey(secrets, false);
  assert.equal(key, 'sk-stored-vault-key-12345');
});

test('resolveApiKey returns and persists process.env.OPENCODE_API_KEY when SecretStorage is empty', async () => {
  const secrets = createMockSecretStorage('');
  const prevEnv = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'sk-env-var-key-67890';
  try {
    const key = await resolveApiKey(secrets, false);
    assert.equal(key, 'sk-env-var-key-67890');
    assert.equal(await secrets.get(SECRET_KEY), 'sk-env-var-key-67890');
  } finally {
    if (prevEnv === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = prevEnv;
  }
});

test('resolveApiKey returns undefined without prompting when promptIfMissing is false', async () => {
  const secrets = createMockSecretStorage('');
  const prevEnv = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  try {
    const key = await resolveApiKey(secrets, false);
    assert.strictEqual(key, undefined);
  } finally {
    if (prevEnv !== undefined) process.env.OPENCODE_API_KEY = prevEnv;
  }
});

test('promptAndSetApiKey with showInputBox: validates input and stores valid key', async () => {
  const secrets = createMockSecretStorage('');
  let validatorFn;
  const mockWindow = {
    showInputBox: async (options) => {
      validatorFn = options.validateInput;
      return '  sk-user-entered-key-abcde  ';
    },
  };

  const key = await promptAndSetApiKey(secrets, mockWindow);
  assert.equal(key, 'sk-user-entered-key-abcde');
  assert.equal(await secrets.get(SECRET_KEY), 'sk-user-entered-key-abcde');

  assert.ok(validatorFn);
  assert.equal(validatorFn(''), 'API Key cannot be empty');
  assert.equal(validatorFn('   '), 'API Key cannot be empty');
  assert.equal(validatorFn('invalid-prefix-key'), 'OpenCode API keys typically start with sk-');
  assert.equal(validatorFn('sk-valid-key'), null);
});

test('promptAndSetApiKey with showInputBox: returns undefined on cancel', async () => {
  const secrets = createMockSecretStorage('');
  const mockWindow = {
    showInputBox: async () => undefined,
  };

  const key = await promptAndSetApiKey(secrets, mockWindow);
  assert.strictEqual(key, undefined);
  assert.strictEqual(await secrets.get(SECRET_KEY), undefined);
});

test('promptAndSetApiKey with createInputBox: triggers openExternal on button click and accepts key', async () => {
  const secrets = createMockSecretStorage('');
  let externalUrlOpened = null;
  const origOpenExternal = vscode.env.openExternal;
  vscode.env.openExternal = async (uri) => {
    externalUrlOpened = uri.toString();
    return true;
  };

  try {
    let acceptHandler;
    let hideHandler;
    let buttonHandler;
    let valueChangeHandler;

    const mockInputBox = {
      title: '',
      prompt: '',
      placeholder: '',
      value: '',
      password: false,
      ignoreFocusOut: false,
      buttons: [],
      validationMessage: undefined,
      onDidTriggerButton: (fn) => { buttonHandler = fn; },
      onDidChangeValue: (fn) => { valueChangeHandler = fn; },
      onDidAccept: (fn) => { acceptHandler = fn; },
      onDidHide: (fn) => { hideHandler = fn; },
      show: () => {},
      hide: () => {},
      dispose: () => {},
    };

    const mockWindow = {
      createInputBox: () => mockInputBox,
    };

    const promptPromise = promptAndSetApiKey(secrets, mockWindow);
    await new Promise((r) => setTimeout(r, 10));

    // Verify title bar button
    assert.ok(Array.isArray(mockInputBox.buttons));
    assert.equal(mockInputBox.buttons.length, 1);
    assert.equal(mockInputBox.buttons[0].tooltip, 'Get API Key at opencode.ai');

    // Trigger button -> opens opencode.ai
    await buttonHandler(mockInputBox.buttons[0]);
    assert.equal(externalUrlOpened, 'https://opencode.ai');

    // Test live validation
    valueChangeHandler('');
    assert.equal(mockInputBox.validationMessage, 'API Key cannot be empty');
    valueChangeHandler('no-sk-prefix');
    assert.equal(mockInputBox.validationMessage, 'OpenCode API keys typically start with sk-');
    valueChangeHandler('sk-fresh-key-123');
    assert.strictEqual(mockInputBox.validationMessage, undefined);

    // Accept input
    mockInputBox.value = 'sk-fresh-key-123';
    await acceptHandler();

    const result = await promptPromise;
    assert.equal(result, 'sk-fresh-key-123');
    assert.equal(await secrets.get(SECRET_KEY), 'sk-fresh-key-123');
  } finally {
    vscode.env.openExternal = origOpenExternal;
  }
});

test('promptAndSetApiKey with createInputBox: resolves undefined when hidden/dismissed', async () => {
  const secrets = createMockSecretStorage('');
  let hideHandler;
  const mockInputBox = {
    title: '',
    prompt: '',
    buttons: [],
    onDidTriggerButton: () => {},
    onDidChangeValue: () => {},
    onDidAccept: () => {},
    onDidHide: (fn) => { hideHandler = fn; },
    show: () => {},
    hide: () => {},
    dispose: () => {},
  };

  const mockWindow = {
    createInputBox: () => mockInputBox,
  };

  const promptPromise = promptAndSetApiKey(secrets, mockWindow);
  await new Promise((r) => setTimeout(r, 10));
  hideHandler();
  const result = await promptPromise;
  assert.strictEqual(result, undefined);
});


