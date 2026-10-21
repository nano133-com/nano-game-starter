// Runs one signature check when the Worker starts (its global scope), with a fixed test vector. The first
// check in a fresh copy of the Worker builds the curve's tables and took about 10 ms of CPU in workerd on a
// laptop: the whole Workers Free budget of one request. Done here, that cost moves to the Worker's start-up,
// which has its own limit (1 second), and a sign-in request then needs about 0.4 ms.
// The vector's key was made from the text "nano-game-starter warm-up vector (test only)": nobody's wallet.

import { verifyBytes } from "@nano133/signin/verify";

const VECTOR = {
  address: "nano_3z35f1d93rfdd3yhzr38ghkd3owdep8c1be8mewh6jfz7aunm6eoh4ixtmfm",
  digest: "864cac635bb696ceeb82f7e9f401094b6a5789961102c1c5bdc8a26c2a53d4fb",
  signature: "54A118EEC036E8F5A31F487A8EEB24260EAAB2662213B68BBB00902C814CAC5A09BC5ACE702CC3159C6EFD15A58E67C56EAE382F10B9796F8050129168AD1F0F",
};

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));

/** True when the check ran and passed (it always should). */
export const warm: boolean = verifyBytes(VECTOR.address, bytes(VECTOR.digest), VECTOR.signature);
