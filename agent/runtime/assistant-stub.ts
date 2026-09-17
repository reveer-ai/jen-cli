#!/usr/bin/env node
/**
 * A coding assistant, as far as anything here is concerned.
 *
 * It reads a prompt on standard input, writes it to the file named as its first argument,
 * and prints one JSON object of the shape a headless assistant prints as its result. That
 * is the whole of the surface `exec` touches — a program, a prompt on `stdin`, one small
 * object on `stdout`, an exit status — so exercising the path against this exercises it
 * against the real thing, minus the account, the network, the image and the tokens.
 *
 * **It exists because there is nothing assistant-shaped in the substrate to test.** No
 * capability, no field, no branch names an assistant; running one is `exec` running a
 * program. So the test for "an agent can run an assistant" can only be a test that `exec`
 * runs *this*, and the fact that it is a complete substitute is the evidence that the
 * substrate really is assistant-neutral.
 *
 * `--fail` makes it exit nonzero with a message on standard error, which is how the path is
 * checked to report an assistant's failure as an ordinary failed result.
 * `--flood` makes it print without stopping, for the output cap.
 *
 * Run as `node assistant-stub.ts <where-to-record-the-prompt> [--fail] [--flood]`.
 */
import { writeFileSync, writeSync } from 'node:fs';

const [, , record, ...flags] = process.argv;

let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

if (record !== undefined && record !== '') writeFileSync(record, prompt);

if (flags.includes('--flood')) {
  // `writeSync` rather than `process.stdout.write`, which on a pipe queues rather than
  // blocks: a loop around it never yields to the event loop, so nothing is ever flushed and
  // the flood is into this process's own memory instead of down the pipe. Blocking on a
  // full pipe is the behaviour a flooding command actually has.
  const line = `${'assistant output '.repeat(64)}\n`;
  for (;;) writeSync(1, line);
}

if (flags.includes('--fail')) {
  process.stderr.write('the assistant could not complete the task\n');
  process.exit(2);
}

process.stdout.write(
  `${JSON.stringify({
    type: 'result',
    is_error: false,
    result: `Read ${prompt.length} characters of instruction and changed the workspace accordingly.`,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  })}\n`,
);
