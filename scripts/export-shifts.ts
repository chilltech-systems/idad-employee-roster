import { readFile, writeFile } from "node:fs/promises";
import { exportShifts } from "../src/lib/shifts";
const [input, directory, output] = process.argv.slice(2);
if (!input || !directory || !output)
  throw new Error(
    "Usage: shifts:export -- input.json directory-records.json output.json",
  );
const result = exportShifts(
  JSON.parse(await readFile(input, "utf8")),
  JSON.parse(await readFile(directory, "utf8")),
);
await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    valid: result.valid,
    exceptions: result.exceptionCount,
    populated: result.populated,
    ready: result.ready,
  }),
);
if (!result.ready) process.exitCode = 2;
