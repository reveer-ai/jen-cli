# The environment an agent's sandbox is built from.
#
# **It is a starting point, not a fixture.** A record names the environment its sandbox is
# built from and the substrate supplies no default, so this is an image a record *can* name
# rather than the one it must. Defining the toolchain an agent works with is the project's
# job — an agent doing Go work needs a Go toolchain and an agent doing data work needs
# something else — and a project extends this or replaces it entirely without the substrate
# noticing which environment it provisioned from.
#
# **Nothing automated builds or tests this.** `agent/` sits outside the repository's checks
# on purpose, so an unpinned component here would change what every agent runs with no file
# in the repository changing and no check reporting it. Every version below is therefore
# exact, and the consequence of relaxing one is an agent behaving differently for reasons
# nothing recorded.
#
# **No credential is baked in, passed as a build argument, or written during the build.**
# There is no `ARG` and no `ENV` carrying one anywhere below, and the assistant's check is
# `--version` precisely because it authenticates to nothing. An image is copied, cached,
# shared and read back layer by layer, so a value written into one is recoverable long
# after the build that put it there. Credentials keep arriving the way the sandbox already
# delivers them: per process, on that process's own standard input.

# The language runtime, at a version that executes the substrate's sources directly.
#
# The substrate's entry point is TypeScript and is never compiled — `agent/tsconfig.json`
# is `noEmit`, and `erasableSyntaxOnly` is what keeps every source strippable. Node strips
# types without a flag from 22.18.0, which is also what `engines` in the manifest already
# requires, so this is a hard requirement of the base rather than a preference: an older
# base produces an image whose `jen-agent` is present and cannot run.
FROM node:22.18.0-bookworm-slim

# The substrate, installed from its own manifest.
#
# The manifest and lockfile are copied first so that a change to a source does not reinstall
# the dependencies, and `npm ci` is what makes the lockfile authoritative rather than
# advisory. `--omit=dev` carries nothing further: the substrate declares no development
# dependency, because the repository already carries the compiler and the test runner and
# neither is needed in here.
WORKDIR /opt/jen-agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# `npm link` rather than a symbolic link written by hand, so the command's name comes from
# the manifest's `bin` and cannot drift from it. What resolves afterwards is `jen-agent`,
# which is the whole of what provisioning needs to name.
RUN npm link

# The entry point **executes**, which is not the same question as whether it exists.
#
# A command that is present and cannot load its own dependencies — or whose sources this
# base will not run — is exactly the failure worth catching here, and `command -v` passes
# over all of it.
#
# **The check cannot be `--help`.** Nothing is read from argv and the boot frame is read
# from standard input, so an invocation that leaves input open waits for a frame that never
# comes: a build that hangs rather than one that fails. Input is closed instead, and what is
# required is a non-zero exit carrying the boot frame's own error — which proves the shebang
# resolves, that Node strips the types, and that `openai` is installed, none of which a
# presence check would notice.
RUN set -eu; \
    if out="$(jen-agent < /dev/null 2>&1)"; then \
      printf 'the agent entry point exited 0 with no boot frame: %s\n' "$out" >&2; \
      exit 1; \
    fi; \
    case "$out" in \
      *'boot frame is missing'*) printf 'the agent entry point runs: %s\n' "$out" ;; \
      *) printf 'the agent entry point failed for some other reason: %s\n' "$out" >&2; exit 1 ;; \
    esac

# A headless coding assistant, pinned, and declared **here rather than in the substrate's
# manifest**.
#
# No part of the substrate may name a particular assistant: an assistant is reached as an
# ordinary command and nothing in the substrate distinguishes one from any other program. A
# dependency entry in `agent/package.json` would be the substrate naming one, and it would
# make replacing the assistant a change to the substrate rather than a change to an
# environment. Kept here, replacing it or providing none is this file and nothing else.
#
# Its check is `--version`, which must run without a credential — see the note above about
# what this image may not contain.
RUN npm install -g @anthropic-ai/claude-code@2.1.277 \
 && claude --version

# The sandbox starts its own idle process and runs everything through `exec`, so this is
# never what a provisioned agent runs. It is here so that the image is runnable on its own
# terms, and what it does is the boot frame's error — the same thing the build checked.
CMD ["jen-agent"]
