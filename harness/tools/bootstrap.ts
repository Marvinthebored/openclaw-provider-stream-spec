import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { implementedGoldens, fixturePath } from "../src/goldens.ts";
import { replayCapture } from "../src/replay.ts";
import { assertInvariants } from "../src/invariants.ts";

for (const golden of implementedGoldens) {
  const capturePath = resolve(golden.capture);
  const result = replayCapture(capturePath, golden.adapter);
  assertInvariants(result);
  const outputPath = resolve(fixturePath(golden));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`
  );
  console.log(`${golden.fixture}: ${result.events.length} events`);
}
