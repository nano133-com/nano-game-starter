// Runs one signature check of each kind when the Worker starts (its global scope), with fixed test vectors. The
// first check in a fresh copy of the Worker is slow: it builds the curve's tables (Berry Wallet, Nautilus) or runs
// the wallet library's code for the first time (NanChat), and each took about 10 ms of CPU in workerd on a laptop:
// the whole Workers Free budget of one request. Done here, that cost moves to the Worker's start-up, which has its
// own limit (1 second), and a sign-in request then needs about 0.4 ms (Berry Wallet, Nautilus) or 2 ms (NanChat).
// `npm run bench:signin` measures it. The vectors' key was made from the text "nano-game-starter warm-up vector
// (test only)": nobody's wallet.

import { verifyBytes, verifyText } from "@nano133/signin/verify";

const ADDRESS = "nano_3z35f1d93rfdd3yhzr38ghkd3owdep8c1be8mewh6jfz7aunm6eoh4ixtmfm";

/** Berry Wallet's and Nautilus's form: Ed25519-BLAKE2b over the bytes (here a SHA-256 digest). */
const BYTES = {
  digest: "864cac635bb696ceeb82f7e9f401094b6a5789961102c1c5bdc8a26c2a53d4fb",
  signature: "54A118EEC036E8F5A31F487A8EEB24260EAAB2662213B68BBB00902C814CAC5A09BC5ACE702CC3159C6EFD15A58E67C56EAE382F10B9796F8050129168AD1F0F",
};

/** NanChat's form: the wallet library's sign() of a text. */
const TEXT = {
  text: "Signed Message: Login to warm-up.example nonce: 00000000000000000000000000000000",
  signature: "39027740904af2b68ae5e73d6934d8f9910f61d85693975e221f10eceb3bda126c5459d1a92e4bd187cc1f61d817da2bc9bac3e7bb316c7592df70d046f3210c",
};

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));

/** True when both checks ran and passed (they always should). */
export const warm: boolean = verifyBytes(ADDRESS, bytes(BYTES.digest), BYTES.signature) && verifyText(ADDRESS, TEXT.text, TEXT.signature);
