# Piko Chrome extension

This template helps you quickly start developing Chrome extensions with React, TypeScript and Vite. It includes the CRXJS Vite plugin for seamless Chrome extension development.

## Features

- React with TypeScript
- TypeScript support
- Vite build tool
- CRXJS Vite plugin integration
- Chrome extension manifest configuration

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Start development server:

```bash
npm run dev
```

3. Open Chrome and navigate to `chrome://extensions/`, enable "Developer mode", and load the unpacked extension from the `dist` directory.

4. Build for production:

```bash
npm run build
```

## Project Structure

- `src/sidepanel/` - CRXJS HTML entry, React bootstrap, and bundled styles
- `src/App.tsx` - Live assistant container and separate synthetic demo
- `src/features/assistant/` - Conversation reducer, orchestrator, question queue, guards, temporary facts, and demo fixtures
- `src/components/layout/` - Header, shell, and workflow progress
- `src/components/assistant/` - Runtime status, conversation, and local microphone controls
- `src/components/review/` - Editable proposals and simulated approval summary
- `src/background/service-worker.ts` - Toolbar behavior, active-tab checks, injection, and lifecycle coordination
- `src/background/approval-coordinator.ts` - Exact reviewed batches, expiry, sender validation, and one-use grants
- `src/features/filling/` - Manual proposals, runtime validation, review, approval, and per-field results
- `src/features/local-service/` - Pairing UI, typed connection messages, capabilities, and runtime status
- `src/background/connection-manager.ts` - Fixed loopback API client and temporary session credentials
- `src/content/fill-engine.ts` - Live preflight, native setters/events, and delayed verification
- `src/components/ui/` - shadcn/ui primitives (nine components)
- `manifest.config.ts` - Chrome extension manifest configuration

## Documentation

- [React Documentation](https://reactjs.org/)
- [Vite Documentation](https://vitejs.dev/)
- [CRXJS Documentation](https://crxjs.dev/vite-plugin)

## Chrome Extension Development Notes

- Use `manifest.config.ts` to configure your extension
- The CRXJS plugin automatically handles manifest generation
- Step 6 adds manual permission-gated filling to explicit inspection. The
  synthetic demo remains separate. See [the filling guide](../../docs/07-permission-gated-filling.md).
- Step 7 adds authenticated companion communication; see [the connection guide](../../docs/08-local-service-connection.md).
- Voice input, Qwen interpretation, and Piper output use the authenticated local companion.
- Production permissions are `sidePanel`, `activeTab`, `scripting`, `storage`,
  and only the loopback service host. No automatic content-script registrations.
- Run `npm run typecheck` and `npm run lint` before building.
- Production ZIP output: `release/crx-piko-extension-0.4.0.zip`.
- See [the root setup guide](../../docs/04-development-setup.md) for full setup
  and manual toolbar verification.
- See [the UI guide](../../docs/05-extension-ui.md) for the demo workflow and tests.
- See [the scanner guide](../../docs/06-form-scanner.md) for scanner architecture,
  the metadata-only contract, fixture setup, and test limitations.
- `src/content/` contains the isolated scanner, registry, labels, visibility, and mutation watcher.
- `src/features/scanner/` contains messages, validation, lifecycle state, and inventory UI.
- `scripts/generate-scanner-validator.cjs` generates a CSP-safe validator from the shared contracts
  before dev, build, and typecheck; the generated JS is ignored and requires no runtime code generation.

## Step 9 interpretation

After pairing and scanning, use **Prepare answers with local Qwen** to edit a
transcript or type an answer. **Interpret edited answer** sends it through the
worker to the authenticated companion, which alone calls local Ollama. Validated
proposals appear in the existing review controls, with inclusion/overwrite
unselected. See [the Qwen guide](../../docs/10-local-qwen-interpretation.md)
for setup, measured model accuracy, limitations and verification.

## Step 10 speech output

**Spoken responses** defaults off. After configuring and pairing a companion with
Piper ready, enable speech to hear the visible question. **Play aloud** provides
manual replay and the autoplay fallback; **Stop speech and record** coordinates
with Whisper capture. Speech is optional and makes no form changes. See the
[Step 10 guide](../../docs/11-local-piper-speech.md) for setup, privacy controls,
voice licensing, measured verification and manual hardware checks.

## Step 11 conversation workflow

Inspection starts the live conversation. Answer the deterministic questions over
multiple turns, edit the current text before interpretation, skip missing answers,
and select proposals for exact batch review. Manual edits stay protected from
later model replies. Filling and submission remain separate user actions.

At approval, **Remember selected answers for this session** is an independent
opt-in. Only successfully verified, eligible answers are reusable on the same
origin, with an absolute 30-minute expiry. **Clear session** removes them and
the live conversation; **Clear scan** keeps confirmed facts. Reopening a panel
requires a fresh scan. See [the workflow guide](../../docs/12-conversation-workflow.md)
for the architecture, test commands, and manual verification.
