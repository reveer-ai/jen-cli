## ADDED Requirements

### Requirement: The documentation states the session-tool version the pipeline requires

The adopter's documentation SHALL state the minimum version of the assistant CLI the
pipeline's sessions are launched with, and SHALL say that a host below it cannot run the
pipeline.

It SHALL be stated as a prerequisite rather than as a note, because the failure it prevents
does not present as a version problem: the invocation carries an option an older CLI does
not recognize, the session is refused before it starts, and the run reports a stage that
produced nothing. An adopter reading that has no reason to look at their CLI version.

#### Scenario: An adopter prepares a host for the pipeline

- **WHEN** the adopter's documentation is read
- **THEN** it names the minimum assistant CLI version the pipeline requires

#### Scenario: An adopter's host is below the minimum

- **WHEN** the pipeline is run on a host whose CLI predates the stated version
- **THEN** the documentation is what tells the adopter why no session starts

## MODIFIED Requirements

### Requirement: The documentation states the permissions the pipeline needs granted

The adopter's documentation SHALL state what a stage session is permitted to do, and SHALL
state that an adopter is not required to enumerate their project's commands for the pipeline
to run them.

It SHALL state that each action is judged on what it is rather than matched against a list,
so ordinary development work — installing declared dependencies, running the project's
checks, the one-off command a task turns out to need — needs no entry. It SHALL NOT tell an
adopter to add their typecheck, lint, build, or test commands as a condition of unattended
runs, and SHALL NOT present jen as shipping a starting shape for any ecosystem's
conventional command names.

It SHALL state that the tracked assistant configuration is theirs to add to where they do
want a rule of their own, and that an entry there is in force in a dispatched run. Any
example configuration the documentation shows SHALL be presented as the entries an adopter
adds, and SHALL NOT be presented as a complete file, so that copying it cannot silently
drop what the file already holds.

Because the assistant configuration is written once at installation and owned by the project from then on, jen SHALL NOT be presented as able to add these later. The documentation is what reaches an install that already exists.

#### Scenario: An adopter prepares a project for unattended runs

- **WHEN** the adopter's documentation is read
- **THEN** it states that the project's own check commands need no permission entry
- **AND** it does not name them as something the adopter must grant

#### Scenario: An adopter's stack is not the one jen assumes

- **WHEN** an adopter whose project is outside any one ecosystem's conventions reads the documentation
- **THEN** it does not describe a starting shape that fails to apply to their project
- **AND** their toolchain is not treated as a case needing extra configuration

#### Scenario: An adopter copies the example

- **WHEN** the documentation's example configuration is copied into a project
- **THEN** whatever the file already holds is not lost by the copying
- **AND** the example is shown as entries to add rather than as the whole file

#### Scenario: An existing install predates the guidance

- **WHEN** a project was installed before this guidance existed
- **THEN** the documentation tells the adopter that the entries jen once wrote are theirs to remove or keep
- **AND** does not suggest that an update will change that file for them

### Requirement: The documentation states what the environment set on the runner reaches

The adopter's documentation SHALL state that the variables an operator sets on the runner reach the pipeline's sessions. It SHALL be stated beside the permissions guidance, which answers the neighbouring half of the same question: the permissions section says a project's own commands run without having to be named in advance, and this says how those commands are given the configuration they read.

It SHALL be stated unconditionally. The passthrough is available on the runner jen ships, which is the only runner it ships, so the documentation SHALL NOT carry a caveat naming a runner the mechanism is unavailable on.

It SHALL state that jen's own namespace is withheld from sessions, and that the variables carrying the role credentials are within it, so an adopter does not read the passthrough as exposing them.

It SHALL state how to narrow a variable to a single stage, and SHALL state that the declaration holds variable *names* rather than values. Any example SHALL name more than one variable: a declaration holding a single name is indistinguishable at a glance from a variable holding a value, and an example that reads that way teaches an adopter to write their secret into it.

It SHALL state that the narrowing keys on the stage rather than on the role. An adopter who reasons from the roles will expect a variable given to the stage that tests to be withheld from the stage that merges, and it is not the role that arranges this, since both act under the same one.

#### Scenario: An adopter supplies their project's own test configuration

- **WHEN** an adopter reads the documentation to learn how their suite reaches its database
- **THEN** it states that variables set on the runner reach the stages
- **AND** it states which namespace is withheld from them

#### Scenario: An adopter narrows a variable to one stage

- **WHEN** an adopter wants a credential to reach only the stage that tests
- **THEN** the documentation gives the declaration that arranges it
- **AND** states that the declaration names variables rather than carrying their values

#### Scenario: The example does not read as carrying a value

- **WHEN** the documentation's example declaration is read
- **THEN** it names more than one variable

#### Scenario: The passthrough carries no runner caveat

- **WHEN** an adopter reads how to supply their project's configuration
- **THEN** the mechanism is stated without qualifying which runner it is available on

#### Scenario: An adopter expects the role to scope it

- **WHEN** an adopter assumes that restricting a variable to testing keeps it from delivery because of their roles
- **THEN** the documentation states that reviewing, testing, and delivering share one role
- **AND** that the narrowing is by stage
