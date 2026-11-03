<div align="center">

<img src="icons/icon.svg" width="96" height="96" alt="Vaani icon">

# Vaani

### Just talk. Vaani takes the notes.

**Free, open-source meeting notes and dictation in 22 languages, including Hindi, Hinglish, Kannada and Tamil.**<br>
Runs in your browser. Nothing to install. No bot joins your call.

### [▶ Try Vaani now, free](https://pradeep411.github.io/vaani/)

[![Try it](https://img.shields.io/badge/try%20it-pradeep411.github.io%2Fvaani-0A66D8?style=flat-square)](https://pradeep411.github.io/vaani/)
[![License: MIT](https://img.shields.io/badge/license-MIT-black?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/languages-22-FF3B30?style=flat-square)](#languages)
[![Notes stay in your browser](https://img.shields.io/badge/notes-stay%20in%20your%20browser-34C759?style=flat-square)](#privacy-what-runs-where)
[![GitHub stars](https://img.shields.io/github/stars/Pradeep411/vaani?style=flat-square)](https://github.com/Pradeep411/vaani/stargazers)

<img src="docs/laptop-notes.png" alt="Vaani on a laptop: notes with summary, action items you can tick off, and decisions" width="860">

</div>

---

## Why Vaani?

Meetings in India switch languages mid-sentence. Most AI note-takers are paid, English-first, upload your recordings, and send a bot into your call. Vaani is the opposite.

- **Free.** No plan, no trial, no credit card.
- **Speaks your language.** 22 languages, and it handles Hinglish-style mixing.
- **Private.** Your audio, transcripts and notes never reach us. They stay in your browser. Where sign-in is switched on, a free account keeps only your email, name and sign-ins, plus simple usage stats if you say yes.
- **One tap.** A red button. Tap, talk, get notes. That's the whole app.

A free, open-source alternative to paid note-takers and dictation apps like Granola, Otter and Wispr Flow, built for how people actually talk.

## How it works

| 1. Tap | 2. Talk | 3. Get notes | 4. Share |
|:---:|:---:|:---:|:---:|
| Press the red button (or <kbd>⌘J</kbd> / <kbd>Ctrl J</kbd>) | Talk normally. Your words appear line by line | Summary, action items, decisions | WhatsApp, email, copy or download |

<div align="center">
<img src="docs/phone-screens.png" alt="Vaani on a phone: tap the red button, your words appear as you talk, then notes arrive with action items you can tick off" width="860">
</div>

<sub>Screens show a sample meeting. The notes were written by an AI engine; the free basic engine gives simpler notes (see below).</sub>

## Features

- 🎙️ **Meeting mode**: live transcript, then notes with a summary, action items, decisions and open questions
- ✍️ **Quick note mode**: speak a thought, get clean, ready-to-send text you can edit
- ✅ **Tickable action items**: tick them off as they get done
- 💬 **Ask your meeting**: "What did Meera promise?"
- 🌐 **Translate notes** into 18 languages
- 📤 **Share anywhere**: WhatsApp, email, your phone's share sheet, copy, or download
- 🗂️ **Your notes, searchable**, grouped by day
- 🧠 **Knows what kind of meeting it was**: management, sales, client, developer, founders, customer support and more. Each gets its own format, with owners on every action item
- 🌙 **Light and dark mode**, phone and laptop layouts
- 📲 **Install it like an app** on your phone or computer (Add to Home Screen / Install)
- ⏱️ **Time saved counter**: see how much typing you skipped
- 📊 **Insights**: your time saved, speaking pace, streak and to-dos, worked out on your device
- 📅 **Coming up from Google Calendar**: join a call and start notes in one tap
- 👤 **Your account, your call**: where sign-in is switched on, download your data, turn off usage stats or delete your account any time in Settings

## Chrome extension

**Vaani pops up when your call starts.** Join a Google Meet, Microsoft Teams or Zoom call in Chrome, and Vaani offers to take notes. One click opens Vaani beside the call.

- **Hears everyone, even with headphones.** Turn on *Hear everyone on a call*, pick the call's tab and switch on *Share tab audio*. Vaani mixes the call's sound with your mic.
- **Notes in the right format.** Vaani works out whether it was a sales call, a management review, a tech sync or a founders' meeting, and writes the notes to match.
- **No bot joins your call.** Nobody sees a "Vaani is recording" guest.

**Install:** Chrome Web Store listing is in review. Until then, [download the latest extension](https://github.com/Pradeep411/vaani/releases?q=extension), unzip it, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.

The extension is a thin shell around the live app, so app improvements reach you instantly. Read the [privacy page](https://pradeep411.github.io/vaani/privacy.html).

## Insights

**See what all that talking added up to.** Open **Insights** in the sidebar (on a phone, it's in the notes menu).

- **Time saved** against typing at 40 words a minute, and every word you captured
- **Meetings and hours**, quick notes, and your **to-dos**: how many are done, what you owe, what others owe you, and what's overdue
- **Your speaking pace** in words a minute, next to typing. We only compare you with typing, never with other people: Vaani has no data on anyone else.
- **Your streak**, with a map of the last 20 weeks
- **Your busiest day and time**, meeting types, languages, and the people with the most to-dos. Tap a name to see their list.
- **Copy my stats** gives you a short plain-text summary to paste anywhere.

All of it is worked out in your browser from the notes you saved. Nothing is sent anywhere.

## Google Calendar: Coming up

**Your next meetings, right on Home.** Connect Google Calendar in **Settings → Calendar** and a *Coming up* list shows your next 36 hours: time (or "In 12 min"), title, who's invited, and whether it's on Meet, Zoom or Teams.

- **Join and take notes** opens the call in a new tab and starts Vaani in meeting mode, hearing everyone, with the note already titled.
- Attendee names help Vaani spell people right and work out who owns each to-do.
- A quiet reminder appears 5 minutes before a meeting starts.

Vaani reads your next 36 hours of events straight from Google into this browser. None of it goes to your Vaani account or any Vaani database. Disconnect any time: it deletes the saved events and asks Google to remove Vaani's access. If Google can't do that without a fresh sign-in, Vaani says so, and you can remove it under Google Account → Security → Third-party connections (myaccount.google.com/connections). A note you take for an event keeps its attendee names and event id; backups leave them out unless you turn on "Include attendee names in backups" in Settings. The access is read-only, the sign-in token lives only in memory, and running your own copy works with your own Google client ID: open the app with `?gcid=1` and use Settings → Calendar → Advanced. Saved events are kept for 36 hours and removed the next time you open Vaani after that.

## The notes engine: free by default, smarter with a key

Vaani never needs an API key. It picks the best engine available, in this order:

| Engine | Cost | Where it runs | What you get |
|---|---|---|---|
| **Your own AI key** (Sarvam AI, OpenAI, Claude or Gemini) | Your key | The provider you choose (text only) | The best notes, any language, Ask and Translate everywhere |
| **On-device AI built into Chrome** | Free | Your computer | Smart notes, Ask and Translate with no key (Chrome on a laptop or desktop that supports it) |
| **Vaani's basic engine** | Free | Your device, works offline | Summary, action items and decisions picked out of your words |

Add a key in **Settings → Notes engine**. It is saved only in your browser and sent only to that provider.

- Sarvam AI (best for Indian languages): [dashboard.sarvam.ai](https://dashboard.sarvam.ai)
- Google Gemini (has a free tier): [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- Anthropic Claude: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

## Privacy: what runs where

We'd rather be precise than make big promises.

| Step | Where it happens |
|---|---|
| Speech to text | **Your browser's speech engine.** Chrome and Edge send the audio to Google or Microsoft to do this. Safari uses Apple's engine. With *Hear everyone on a call* on, the other people's voices go there too. Vaani itself never receives your audio. |
| Notes (free engines) | **On your device.** |
| AI (your own key) | **Text goes to the provider you picked** whenever Vaani writes notes, answers a question, recaps your week, translates or drafts a follow-up. Ask and Recap send the notes they search. Never the audio. |
| Saved notes | **Only in this browser** (local storage, or IndexedDB when that is full). Clearing browser data deletes them. |
| Insights | **On your device**, from your saved notes. |
| Google Calendar (only if you connect it) | **Straight from Google into this browser.** Read-only. The token stays in memory; event titles, times and links are kept for 36 hours, and removed the next time you open Vaani after that. Attendee names stay on this device, and stay out of backups unless you turn them on. |
| Your account (where sign-in is switched on, 18 or older) | **Google Firebase.** Email, name, sign-up date and sign-in times. Sign-in is held in the US, the rest in Mumbai, India. Download or delete it in Settings. |
| Usage stats (only if you say yes) | **Google Firebase, Mumbai.** Meeting type, length, language, device type and features used. Never what was said. Kept 12 months. |
| Under 18 | **No account.** Nothing about you is kept; only an anonymous daily count of opens and notes, with no name or device attached. |
| Ads, selling data, outside analytics | **None.** |

**Accounts.** Vaani 2.2 can ask adults to sign in once, with Google or a one-time email link (no passwords). The owner switches this on only after the Chrome Web Store listing and Privacy tab update is approved; until then Vaani works with no account at all, exactly as before. Where it is on, the first screen asks "Are you 18 or older?". Adults sign in, then agree to the account basics in one box and choose usage stats in a second, unticked box. People under 18 skip all of it and use every feature with no account. On a shared computer, each account's notes are kept apart in that browser, and signing out can remove them.

Full details, how long we keep things and how to reach us: [privacy policy](https://pradeep411.github.io/vaani/privacy.html).

Please tell people when you are taking notes. It's polite, and in many places it's the law.

## Languages

English (India, US, UK), Hindi, Kannada, Tamil, Telugu, Marathi, Bengali, Gujarati, Malayalam, Punjabi, Urdu, Spanish, French, German, Arabic, Portuguese, Russian, Chinese, Japanese, Indonesian.

Speech recognition comes from your browser. **Chrome supports all 22**; support in Safari and Edge varies by language. Pick "English (India)" for Hinglish.

## Works best in

| Browser | Recording |
|---|---|
| Chrome (desktop and Android) | ✅ Best |
| Edge | ✅ |
| Safari (Mac and iPhone) | ✅ |
| Firefox | ❌ No built-in speech engine yet. Your saved notes still open. |

**Online calls:** turn on **Hear everyone on a call** (or use the [Chrome extension](#chrome-extension)), then pick the call's tab and switch on *Share tab audio*. Vaani hears both sides, even with headphones. For the Zoom or Teams desktop apps, keep the call on your speakers for now.

## Run it yourself

Vaani is one HTML file. No build step, no dependencies.

- **Use it:** [pradeep411.github.io/vaani](https://pradeep411.github.io/vaani/)
- **Host your own copy:** fork this repo → Settings → Pages → Deploy from branch → `main`, root. Done.
- **Sign-in on your copy:** Vaani's sign-in uses Firebase and is off by default (`VAANI_ACCOUNTS_ENABLED` in `accounts.js`). A fork that turns it on needs its own Firebase project and config (`firebase-config.js`, the project ID in the page's CSP), and its own privacy policy naming whoever runs it, because that person becomes responsible for the account data.
- **Run locally:** download the repo and open `index.html` in Chrome, or run `python3 -m http.server` in the folder and open `http://localhost:8000`.

## Roadmap

- [x] Chrome extension that pops up when a Meet, Teams or Zoom call starts
- [ ] Mac and Windows app for the Zoom and Teams desktop apps
- [ ] Speaker names ("Priya", "Arjun") in the transcript
- [ ] Sarvam speech-to-text for higher accuracy in Indian languages (with your key)
- [ ] Export to Notion, Google Docs and Slack
- [ ] More languages: Odia, Assamese and more

Have an idea? [Open an issue](https://github.com/Pradeep411/vaani/issues).

## Contributing

The most useful help right now:

1. **Test it in your language** and [tell us](https://github.com/Pradeep411/vaani/issues) what it got wrong.
2. **Improve the basic engine** for your language (the word lists live in `basicNotes()` in `index.html`).
3. **Fix a bug or polish a screen.** See [CONTRIBUTING.md](CONTRIBUTING.md).

## If Vaani saved you time

⭐ **Star the repo.** It's the single best way to help other people find it.<br>
📤 **Share it** with one person who takes notes in meetings.

[![Star History Chart](https://api.star-history.com/svg?repos=Pradeep411/vaani&type=Date)](https://star-history.com/#Pradeep411/vaani&Date)

---

<div align="center">

Built in Bengaluru by [Pradeep Zille](https://www.linkedin.com/in/pradeepzille). MIT licensed: use it, change it, share it.

</div>
