/**
 * A supervisor in a process of its own, so a test can kill one.
 *
 * `containers.test.ts` needs a supervisor that dies the way a real one does — the whole
 * process group, without warning, with sandboxes running — and a test cannot do that to the
 * process it is itself running in. So this is the supervisor, started detached, holding real
 * sandboxes, ready to be killed.
 *
 * Test support. Nothing the substrate runs imports it, and it is a program rather than a
 * module for the same reason `runtime/main.ts` is.
 */
import { DockerSandboxDriver } from '../sandbox/docker.ts';
import { Supervisor } from './index.ts';
import { Store } from './store.ts';

import type { AgentRecord } from '../record.ts';

/**
 * A protocol peer written in the shell a sandbox already has to provide.
 *
 * **Not a runtime, and deliberately not one.** What the integration tier is about is
 * containers — that a dormant tree holds none, that a run killed with sandboxes running is
 * swept and resumes — and driving that through a real model would make every assertion
 * depend on reasoning. `sh` is the whole of what `agent-sandbox` asks of an environment, so
 * this needs no build and no bespoke image.
 *
 * It decides what to do from its own boot frame and from nothing else, which is the same
 * decision the real entry point makes: a body the supervisor says owes a step takes one, and
 * a body it says nothing about waits to be told something. Neither is a flag meaning "was
 * resumed" — `owed` is set for an ordinary delivery to a dormant agent too.
 *
 * Its charter is how a test tells one agent from another: `STAY` asks for its body to be
 * kept, `HOLD` goes quiet mid-turn and never answers, anything else finishes its turn.
 *
 * **Every record driving it has to grant what its script calls.** `STAY` raises an `await`,
 * and the supervisor refuses a request the caller's record does not name — while this peer
 * reads answers and acts on none of them. So a record that withheld `await` would leave the
 * agent working forever and the wait below would time out, which reads as a container
 * problem and is a grant.
 */
export const SHELL_PEER = `
IFS= read -r boot
mode=GO
case "$boot" in *HOLD*) mode=HOLD ;; *STAY*) mode=STAY ;; esac
echo started >> /workspace/history
case "$boot" in
  *'"owed":true'*)
    printf '%s\\n' '{"t":"event","event":{"type":"message","at":"2026-01-01T00:00:00.000Z","from":"self","content":"continued"}}'
    printf '%s\\n' '{"t":"turn","message":"continued","residency":0}'
    ;;
esac
while IFS= read -r line; do
  case "$line" in
    *'"t":"stop"'*)
      exit 0
      ;;
    *'"t":"message"'*)
      printf '%s\\n' '{"t":"event","event":{"type":"charter","at":"2026-01-01T00:00:00.000Z","content":"a shell peer"}}'
      printf '%s\\n' '{"t":"event","event":{"type":"usage","at":"2026-01-01T00:00:00.000Z","in":1,"out":1,"model":"sh"}}'
      if [ "$mode" = HOLD ]; then
        continue
      fi
      if [ "$mode" = STAY ]; then
        printf '%s\\n' '{"t":"request","id":"r1","kind":"await","input":{},"residency":60000}'
      else
        printf '%s\\n' '{"t":"turn","message":"done","residency":0}'
      fi
      ;;
  esac
done
`;

export interface HarnessConfig {
  root: string;
  run: string;
  records: AgentRecord[];
  /** Printed once every agent named here has reached this state. */
  until: 'working' | 'waiting';
}

if (process.argv[1]?.endsWith('harness.ts') === true) {
  const config = JSON.parse(process.argv[2] ?? '{}') as HarnessConfig;
  const store = await Store.open(config.root, config.run);
  const supervisor = new Supervisor({
    store,
    driver: new DockerSandboxDriver({ run: config.run }),
    command: ['sh', '-c', SHELL_PEER],
  });

  for (const record of config.records) await supervisor.add(record, 'Begin.');

  // Said once, when the tree is in the state the test wants to kill it in. Polling the store
  // rather than reporting each transition, because what the test is waiting for is a
  // property of the whole tree.
  //
  // **`working` additionally requires a stored step.** An agent becomes `working` the moment
  // its message is delivered, which is before its body has emitted anything — so a kill on
  // that signal alone can land on an agent that is mid-turn and has recorded nothing, and
  // "resumes from records and transcripts alone" then resumes from an empty transcript and
  // proves much less than it reads as proving. Which side of that race a run landed on
  // varied between runs, so the test was flaky rather than wrong-and-consistent.
  const settled = async (): Promise<boolean> => {
    for (const record of config.records) {
      if (store.agent(record.id).state.status !== config.until) return false;
      if (config.until === 'working' && (await store.transcript(record.id)).length === 0) return false;
    }
    return true;
  };
  while (!(await settled())) await new Promise((resolve) => setTimeout(resolve, 50));

  process.stdout.write('ready\n');
  // Held open to be killed. Nothing here ever resolves.
  await new Promise(() => {});
}
