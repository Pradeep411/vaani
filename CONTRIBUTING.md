# Contributing to Vaani

Thanks for helping. Vaani is one file (`index.html`) with no build step, so you can start in a minute.

## Run it

```bash
git clone https://github.com/Pradeep411/vaani.git
cd vaani
python3 -m http.server 8000
# open http://localhost:8000 in Chrome
```

## Good first contributions

- **Your language.** Record a short meeting in your language and open an issue with what Vaani got wrong.
- **The basic engine.** `basicNotes()` in `index.html` picks out action items and decisions with simple word lists. Adding words for your language (like "karega", "bhej dena") makes free notes better for everyone.
- **Screens.** Keep the design calm: one red record button, system fonts, one blue tint, no clutter.

## Rules

- **Never commit an API key.** Keys belong in the app's Settings, which saves them only in the user's browser.
- Keep it one file with no dependencies, so anyone can host it by forking.
- Be honest in the UI and docs about where data goes.

## Pull requests

Small and focused is best. Describe what changed and include a screenshot for anything visual.
