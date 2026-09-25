import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { verifyApiKey } from '../config.js';
import { invocationCwd } from '../paths.js';
import {
  cliConfig, configPath, persistConfig, currentWorkspace, parseWorkspaceInput,
  PROVIDERS, PROVIDER_LABEL, PROVIDER_KEY_FIELD, PROVIDER_DEFAULT_MODEL, PROVIDER_KEY_URL
} from './session.js';
import type { Provider } from './session.js';

/**
 * First-run configuration. Runs before the gateway is booted, because starting the
 * LLM proxy against a placeholder key just produces an "invalid API key" error from
 * the provider with no indication of which file to edit.
 */
export function SetupWizard({ onComplete, onCancel }: {
  onComplete: (summary: string[]) => void;
  onCancel?: () => void;
}) {
  const configured = String(cliConfig.apiProvider ?? '');
  const initialProvider: Provider =
    (PROVIDERS as readonly string[]).includes(configured) ? (configured as Provider) : 'gemini';

  const [step, setStep] = useState<'provider' | 'key' | 'model' | 'workspace'>('provider');
  const [cursor, setCursor] = useState(Math.max(0, PROVIDERS.indexOf(initialProvider)));
  const [provider, setProvider] = useState<Provider>(initialProvider);
  const [keyValue, setKeyValue] = useState('');
  const [modelValue, setModelValue] = useState('');
  const [workspaceValue, setWorkspaceValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checking, setChecking] = useState(false);

  // Only offered once there is a working config to fall back to. On a first run there is
  // nothing to cancel back to, so Esc would just strand the user on an empty screen.
  useInput((_input, key) => {
    if (key.escape) onCancel!();
  }, { isActive: Boolean(onCancel) && !checking });

  useInput((input, key) => {
    if (key.upArrow) { setCursor(c => (c + PROVIDERS.length - 1) % PROVIDERS.length); return; }
    if (key.downArrow) { setCursor(c => (c + 1) % PROVIDERS.length); return; }
    const typed = Number(input);
    if (typed >= 1 && typed <= PROVIDERS.length) { setCursor(typed - 1); return; }
    if (key.return) {
      const chosen = PROVIDERS[cursor] as Provider;
      const existingKey = cliConfig.llmProxy?.[PROVIDER_KEY_FIELD[chosen]];
      const keptProvider = chosen === cliConfig.apiProvider;
      setProvider(chosen);
      // Carry a real key over so re-running setup is not a retype; skip placeholders.
      setKeyValue(existingKey && !/^YOUR-/i.test(existingKey) ? existingKey : '');
      // Only reuse the configured model when the provider is unchanged. Carrying it
      // across a switch is exactly how a Mistral model name ended up under Gemini.
      setModelValue((keptProvider && cliConfig.llmProxy?.model) || PROVIDER_DEFAULT_MODEL[chosen]);
      setStep('key');
    }
  }, { isActive: step === 'provider' });

  // Checked against the provider before it is accepted. A key that only fails later, on
  // the first chat turn, surfaces as an opaque 401 with the setup screen long gone.
  const submitKey = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || /^YOUR-/i.test(trimmed)) {
      setError('A real API key is required. Paste one to continue.');
      return;
    }

    setError('');
    setNotice('');
    setChecking(true);
    const check = await verifyApiKey(provider, trimmed);
    setChecking(false);

    if (check.status === 'rejected') {
      setError(`${check.message} Paste a different key, or press Esc to go back.`);
      return;
    }
    // Being offline must not stop someone configuring the tool, so an unreachable
    // provider is a warning rather than a refusal.
    if (check.status === 'unknown') {
      setNotice(`${check.message} Saving it unverified.`);
    }

    setKeyValue(trimmed);
    setStep('model');
  };

  const submitModel = (value: string) => {
    setModelValue(value.trim() || PROVIDER_DEFAULT_MODEL[provider]);
    const existing = currentWorkspace();
    setWorkspaceValue(existing.join(', '));
    setError('');
    setStep('workspace');
  };

  const submitWorkspace = (value: string) => {
    const parsed = parseWorkspaceInput(value.trim() || invocationCwd());
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }

    const model = modelValue.trim() || PROVIDER_DEFAULT_MODEL[provider];
    if (!cliConfig.llmProxy) {
      cliConfig.llmProxy = { enabled: true, port: 4141, host: '127.0.0.1' };
    }
    cliConfig.apiProvider = provider;
    cliConfig.llmProxy[PROVIDER_KEY_FIELD[provider]] = keyValue;
    cliConfig.llmProxy.model = model;
    cliConfig.allowedDirectories = parsed.dirs;

    const err = persistConfig();
    onComplete(err
      ? [`Could not save config: ${err}`]
      : [
          `Provider: ${PROVIDER_LABEL[provider]}`,
          `Model: ${model}`,
          `Folders: ${parsed.dirs.join(', ')}`,
          `Saved to ${configPath}`
        ]);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="cyan" bold>JustBetter setup</Text>
      <Text dimColor>{configPath}</Text>
      <Box height={1} />

      {step === 'provider' ? (
        <Box flexDirection="column">
          <Text>Which API provider should power the chat?</Text>
          <Box height={1} />
          {PROVIDERS.map((option, index) => (
            <Text key={option} {...(index === cursor ? { color: 'green' } : {})}>
              {index === cursor ? '>' : ' '} {index + 1}. {PROVIDER_LABEL[option]}
            </Text>
          ))}
          <Box height={1} />
          <Text dimColor>Up/Down or a number to choose, Enter to confirm.</Text>
        </Box>
      ) : null}

      {step === 'key' ? (
        <Box flexDirection="column">
          <Text>Paste your {PROVIDER_LABEL[provider]} API key.</Text>
          <Text dimColor>Get one at {PROVIDER_KEY_URL[provider]}</Text>
          <Box height={1} />
          {checking ? (
            <Text color="cyan">Checking the key with {PROVIDER_LABEL[provider]}...</Text>
          ) : (
            <Box>
              <Text color="blue" bold>Key {'>'} </Text>
              <TextInput
                value={keyValue}
                onChange={value => { setKeyValue(value); if (error) setError(''); }}
                onSubmit={value => { void submitKey(value); }}
                mask="*"
              />
            </Box>
          )}
          {error ? <Text color="red">{error}</Text> : null}
        </Box>
      ) : null}

      {step === 'model' ? (
        <Box flexDirection="column">
          <Text>Which model? Enter accepts the default.</Text>
          <Box height={1} />
          <Box>
            <Text color="blue" bold>Model {'>'} </Text>
            <TextInput value={modelValue} onChange={setModelValue} onSubmit={submitModel} />
          </Box>
          {notice ? <Text color="yellow">{notice}</Text> : null}
        </Box>
      ) : null}

      {step === 'workspace' ? (
        <Box flexDirection="column">
          <Text>Which folder should the agent be allowed to read and write?</Text>
          <Text dimColor>Separate several with commas. Enter accepts the default.</Text>
          <Box height={1} />
          <Box>
            <Text color="blue" bold>Folder {'>'} </Text>
            <TextInput
              value={workspaceValue}
              onChange={value => { setWorkspaceValue(value); if (error) setError(''); }}
              onSubmit={submitWorkspace}
            />
          </Box>
          {error ? <Text color="red">{error}</Text> : null}
        </Box>
      ) : null}

      {onCancel && !checking ? (
        <>
          <Box height={1} />
          <Text dimColor>Esc to cancel and keep the current settings.</Text>
        </>
      ) : null}
    </Box>
  );
}
