# autoForm

**Open-source Chrome extension that learns your answers and auto-fills applications — for students, startups, and job seekers.**

Whether you're a student applying to scholarships and schools, a startup applying to accelerator programs and grants, or an individual sending out job applications — you're filling the same fields over and over. autoForm remembers your answers and fills future forms automatically, or with one click.

It connects to any OpenAI-compatible LLM (GPT, Claude, Gemini, Groq, Ollama, LM Studio) to suggest answers for fields you haven't filled before, so even new forms get completed faster.

Built with plain JavaScript (no frameworks, no build step). MV3 compliant.

## What autoForm does

| Feature | Explanation |
|---|---|
| **Auto-learn while typing** | Every answer you type into a form field is saved in real time. No button needed — just type and it remembers. |
| **Smart field matching** | Recognises form fields by label, `name`, `id`, `placeholder`, `aria-label`, `aria-labelledby`, and surrounding DOM context. Even handles `<fieldset>/<legend>` groups. |
| **Fuzzy matching** | When an exact key match isn't found, uses Dice coefficient token-set similarity (threshold 0.5) with a name-part guard to avoid wrong matches like "first_name" → "full_name". |
| **One-click autofill** | Press the autoForm icon and hit "Autofill now" — empty fields get filled from your saved answers instantly. |
| **LLM answer suggestions** | "Suggest with AI" sends unfilled fields to your LLM, which generates realistic answers based on your saved profile as context. |
| **Multiple profiles** | Create separate profiles for different application types (e.g. "Software Engineer", "Design Role", "Freelance"). Switch between them in one click. |
| **Site tracking** | Every saved answer records which website it was first seen on, so you know where your data came from. |
| **Provider auto-fill** | Select "OpenAI", "Groq", "Ollama", etc. and the extension auto-fills the base URL, model, temperature, and token limits. |

| **Form submit capture** | When you submit a form, all current field values are snapshotted and saved for future use. |
| **Export / import** | Back up all your profiles and answers as a JSON file, or restore from a previous backup. |

---

## Features

### Core Autofill
- [x] **Auto-learn while typing** — saves every answer you type as you type it
- [x] **Smart matching** — matches form fields by label, name, placeholder, `aria-label`, and DOM context
- [x] **Dice coefficient matching** — falls back to fuzzy token-set matching when exact keys don't match
- [x] **Select / radio / checkbox support** — handles all standard form input types
- [x] **React-compatible** — uses native prototype setters so controlled inputs pick up changes
- [x] **MutationObserver** — detects dynamically added fields (SPAs, lazy-loaded forms)
- [x] **Form submit capture** — snapshots all answers on submit for future use

### Profiles
- [x] **Multiple profiles** — create separate profiles (e.g. "Software Engineer", "Design Role")
- [x] **Unlimited profiles and answers** — no artificial caps in any plan tier
- [x] **Site tracking** — records which site each answer was first seen on
- [x] **Inline editing** — edit questions and answers directly in the settings page
- [x] **Grouped by site view** — browse answers organised by origin website

### AI-Powered Features
- [x] **LLM suggest** — "Suggest with AI" fills empty fields using your saved answers as context
- [x] **Semantic matching** — LLM maps current form questions to your saved answers by meaning
- [x] **Provider auto-fill** — select OpenAI / Groq / Gemini / Ollama / LM Studio and all fields populate automatically
- [x] **Any OpenAI-compatible endpoint** — works with local or remote APIs
- [x] **One-click test** — verify your LLM connection with a single button

### Providers
- [x] OpenAI
- [x] OpenRouter
- [x] Groq
- [x] Google Gemini
- [x] Ollama (local)
- [x] LM Studio (local)
- [x] Custom (any OpenAI-compatible API)

### Accounts & Sync
- [x] **Local mode** — works entirely offline, no account required
- [x] **Firebase auth** — Google and Apple sign-in (optional, for future cloud sync)
- [x] **Plan tiers** — Free / Pro groundwork with per-plan limits ready to enable
- [x] **Export / import** — backup and restore all data as JSON

### Popup Controls
- [x] **Autofill now** — one-click fill using heuristic + LLM matching
- [x] **Suggest with AI** — LLM generates answers for empty fields
- [x] **Save this page's answers** — snapshot all current values
- [x] **Auto-fill toggle** — enable/disable automatic filling
- [x] **Auto-save toggle** — enable/disable learn-while-typing
- [x] **Profile & connection switcher** — switch profiles and LLM connections without opening settings

---

## Getting Started

### Prerequisites
- Google Chrome (or Chromium-based browser)
- Node.js (only needed for generating Firebase config)

### Install

1. **Clone the repo**
   ```bash
   git clone https://github.com/your-username/autoform.git
   cd autoform
   ```

2. **(Optional) Configure Firebase for account sync**
   ```bash
   cp .env.example .env
   # Fill in your Firebase project credentials
   npm run build:config
   ```

3. **Load in Chrome**
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select the project root folder

4. **Configure an LLM connection** (for AI features)
   - Click the autoForm icon → **Settings** (or open the options page)
   - Go to **AI Settings** tab
   - Select a provider (e.g. OpenAI, Ollama), enter your API key, and save
   - Click **Test** to verify the connection

### Local LLM (Ollama)

If you're using Ollama locally, you may need to allow browser extension origins:

```bash
setx OLLAMA_ORIGINS "*"
# Then restart Ollama
```

---

## Project Structure

```
autoform/
├── manifest.json          # MV3 extension manifest
├── background.js          # Service worker — state, LLM calls, message hub
├── content-script.js      # Injected into pages — autofill, learn, match
├── firebase-config.js     # Auto-generated Firebase config (gitignored)
├── shared/
│   ├── account.js         # Plan tiers and account helpers
│   ├── providers.js       # LLM provider presets (single source of truth)
│   ├── matching.js        # Text normalisation & answer matching (shared by background.js and content-script.js)
│   └── crypto.js          # At-rest encryption for connection API keys
├── popup/
│   ├── popup.html         # Toolbar popup UI
│   └── popup.js           # Popup controller
├── options/
│   ├── options.html       # Settings page
│   └── options.js         # Settings controller
├── account/
│   ├── account.html       # Sign-in / account management page
│   └── account.js         # Account page controller
├── lib/
│   ├── firebase-app-compat.js   # Vendored Firebase App SDK
│   └── firebase-auth-compat.js  # Vendored Firebase Auth SDK
├── scripts/
│   └── gen-firebase-config.js   # Generates firebase-config.js from .env
├── icons/                 # Extension icons
├── tests/                 # Jest unit tests for the shared/ and background.js logic
├── .env.example           # Firebase credential template
├── LICENSE                # CC BY-NC 4.0
└── package.json           # Build scripts and test runner
```

---

## Tech Stack

- **Plain JavaScript** — no frameworks, no transpiler, no bundler
- **Chrome Extensions MV3** — service worker, content scripts, chrome.storage
- **Firebase Auth** (optional) — Google/Apple sign-in via vendored compat SDK
- **OpenAI-compatible chat completions API** — works with any provider

---

## Testing

Unit tests cover the pure logic that's safest to regress silently: answer
matching (`shared/matching.js`), plan/account helpers (`shared/account.js`),
provider presets (`shared/providers.js`), API-key encryption
(`shared/crypto.js`), and the storage/migration logic in `background.js`
(answer saving, plan limits, state migrations).

```bash
npm install
npm test
```

DOM-driven code (content-script.js's field scanning, and the popup/options/
account page controllers) isn't covered by automated tests — verify those
manually by loading the unpacked extension in Chrome.

---

## Permissions

| Permission | Why |
|---|---|
| `storage` | Store profiles, answers, and settings |
| `activeTab` | Send autofill commands to the current tab |
| `webNavigation` | Detect frames for multi-frame page support |
| `scripting` | Inject content script into tabs that predate the extension |
| `<all_urls>` | Run on any website to autofill forms |

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a PR

---

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License](LICENSE) (CC BY-NC 4.0).

You are free to:
- **Share** — copy and redistribute the material in any medium or format
- **Adapt** — remix, transform, and build upon the material

Under the following terms:
- **Attribution** — you must give appropriate credit, provide a link to the license, and indicate if changes were made
- **NonCommercial** — you may not use the material for commercial purposes

The copyright holder (autoForm contributors) retains the right to use, modify, and distribute the material commercially under separate terms.

---

## Acknowledgements

- Built to solve the pain of filling out the same application forms repeatedly
- LLM integration designed to work with both cloud APIs and local models for privacy-conscious users
