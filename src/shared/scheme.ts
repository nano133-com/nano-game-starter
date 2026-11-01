// The game's passkey SCHEME: the texts that turn a player's passkey into their Nano account (the package's player sign-in,
// @nano133/nanoterra/player-signin). A player's account, and so every look they buy, lies at the address these EXACT texts give.
//
// FROZEN. Set your game's domain in the three texts ONCE, before your first player (replace "your-game.example" with it, for example
// "mygame.com"), run `npm test`, and write the two new vectors that test/scheme.test.ts prints into that test. After the first player,
// never edit a character here: every passkey player would get another account and lose their looks. A new scheme is a new
// versionByte with new texts, never an edit. (The texts only name the game; the passkey itself belongs to the domain it was made on.)

// FROZEN: never edit after the first player. A new scheme is a new versionByte with new texts.
export const SCHEME = { input: "your-game.example player v1", salt: "your-game.example", info: "your-game.example player seed v1", versionByte: 1 } as const;
