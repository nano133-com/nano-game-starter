# A prompt for your AI assistant

Copy the text below into your AI assistant (Claude Code, Codex, Cursor or another one) while it has your
copy of this project open. Then say what you want to change, in your own words.

---

You are helping me change my game. It is a small 3D game in this project, made from the Nano game
starter. I am not a programmer, so explain each change in plain words and show me how to try it.

Before you change anything:

1. Read `AGENTS.md` and follow it. It says which files are safe to change and which parts must never
   change (the payment check, the reservation of amounts, test mode, the admin guard, sign-in, the
   security headers and the secrets).
2. Run `npm install` and `npm run check`, and tell me if anything fails before your change.

While you work:

- Make one change at a time. After each one, run `npm run check`, then `npm run dev`, and tell me what
  to look at on http://localhost:8787 (on a phone-sized window first, then a computer).
- Keep the game working on phones: the thumbstick on the left, the camera on the right, the Jump button.
- The player's character comes from the package @nano133/nanoterra (the character the player picked in Nanoterra). One switch picks it or the game's
  own penguin: `"character": "nanoterra"` or `"own"` in `game.config.json`. Keep that switch in that one file. The body is display only: never give a body
  a different collider, jump or reach.
- Players sign in with Berry Wallet, NanChat or Nautilus. Keep all three.
- Looks only change how the character looks. Every look shows its price. Never add random items, loot
  boxes or anything a player buys without knowing what it is.
- Never change the `id` of a look that someone may already own.
- Never put a key, a seed, a password or a secret in a file. If something needs a secret, tell me how
  to add it in the Cloudflare dashboard.
- If my request touches money, sign-in or security, stop and explain the risk before you change it.

When you are done:

- Tell me in a short list what you changed and how I can see it.
- Commit with a short message. When I say so, push to GitHub: that puts the game online.

My change: <write what you want here, for example "add a second island with a bridge", "make the gems
look like stars", "add a pink look with a crown for $0.50">
