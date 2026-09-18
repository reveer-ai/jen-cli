## ADDED Requirements

### Requirement: `read` is an ordinary record-selected capability

The substrate SHALL declare `read` through the runtime's existing capability interface. It SHALL have an agent-facing name, description, and input schema, and SHALL forward its invocation to the supervisor on the ordinary correlated request channel. The reasoning loop SHALL NOT contain a capability-specific path for it.

The runtime SHALL offer `read` to an agent if and only if its record names it, on the same terms as every other capability. Registering the declaration SHALL NOT grant it.

The agent-facing input SHALL name the agent whose transcript is wanted and nothing else. The supervisor's authorization — that the target descends from the caller — and its handling of ranges are unchanged by this declaration, and the range is not part of what the model supplies.

#### Scenario: A record grants read

- **WHEN** an agent's record names `read` among its tools
- **THEN** the model is offered `read` through the same interface as any other capability
- **AND** invoking it raises a `read` request to the supervisor

#### Scenario: A record does not grant read

- **WHEN** an agent's record does not name `read`
- **THEN** the runtime does not offer `read` to its model
- **AND** the agent runs the same runtime implementation as one whose record does name it

#### Scenario: The model supplies no range

- **WHEN** a model invokes `read`
- **THEN** it names only the agent whose transcript it wants
- **AND** no offset, count or bound is part of the input it supplies

#### Scenario: A refused read is a result the agent can act on

- **WHEN** an agent invokes `read` for an agent that is not its descendant
- **THEN** the supervisor's refusal is presented to the model as a normal failed capability result
- **AND** the agent's turn can continue

### Requirement: A read places the transcript in the caller's workspace and answers with its location

An invocation of `read` SHALL write the target's transcript into the requesting agent's workspace and SHALL answer the model with the location it was written to. The answer SHALL NOT carry the transcript's content.

This is what makes full visibility affordable. A capability's result is carried again on every later model call, so a transcript returned once is paid for on every step that follows; a transcript on disk is paid for only where the agent chooses to look at it, with the tools it already holds. An agent inspecting a descendant's work can therefore ask a narrow question of an arbitrarily long record at a cost proportional to the answer rather than to the record.

The written transcript SHALL carry every stored event for the target, including reasoning content the provider returned in a representation of its own. Nothing SHALL be selected, elided or summarized on the way: what the supervisor stores is what is written.

A repeated read of the same target SHALL replace what the previous read wrote rather than accumulating beside it, so that the location holds one transcript and that transcript is the one most recently fetched. A read SHALL therefore be safe to repeat, including after one whose outcome is unknown.

Where the transcript cannot be written, the invocation SHALL return a failed result naming what happened. It SHALL NOT raise an error that ends the agent, and the failure SHALL leave the supervisor's stored transcript untouched, so that the call can be made again.

#### Scenario: The agent is answered with a location, not a transcript

- **WHEN** an agent invokes `read` for a descendant
- **THEN** the result names where in its workspace the transcript was written
- **AND** the result does not contain the transcript's events

#### Scenario: A long transcript does not enter the caller's context

- **WHEN** an agent reads a transcript far larger than what a result may carry
- **THEN** the whole transcript is written to its workspace
- **AND** what the model receives is bounded by the description of a location rather than by the size of the transcript

#### Scenario: What was stored is what is written

- **WHEN** a transcript containing provider reasoning content is read
- **THEN** the written transcript carries every stored event, reasoning content included

#### Scenario: Reading the same agent twice leaves one transcript

- **WHEN** an agent reads the same descendant a second time
- **THEN** the location holds the transcript as most recently fetched
- **AND** no second transcript for that agent accumulates beside it

#### Scenario: A transcript that cannot be written is a result, not a crash

- **WHEN** the transcript cannot be written to the workspace
- **THEN** the invocation returns a failed result naming what happened
- **AND** the agent continues working
- **AND** the transcript remains available to be read again

### Requirement: A capability may do work in place and raise a request in one invocation

A capability SHALL be permitted to both raise a request to the supervisor and perform work inside the agent's own sandbox within a single invocation. Neither the reasoning loop, the dispatcher, nor the protocol SHALL distinguish such a capability from one that only does the first or only does the second.

The substrate began with two disjoint kinds — capabilities that forward and do nothing locally, and capabilities that work locally and forward nothing — and that division was a fact about the capabilities that existed rather than a constraint the runtime imposes. What the runtime requires is that no capability have a path of its own through the loop, the dispatcher or the protocol. Where an invocation's own body does is not something any of the three can observe, and a rule against composing would be the runtime holding knowledge about a particular capability, which is the authority the uniformity requirement exists to deny it.

Work such a capability does in place SHALL be subject to the same rules as any other capability's: a failure SHALL be returned as that invocation's result, and work the runtime cannot otherwise end SHALL be bounded by the capability itself.

#### Scenario: A composing capability is dispatched like any other

- **WHEN** a capability that both raises a request and works locally is invoked
- **THEN** it is dispatched by the same code that dispatches every other capability
- **AND** nothing in the loop, the dispatcher or the protocol distinguishes it

#### Scenario: The local half failing is a result

- **WHEN** the work such a capability performs in place fails after its request has been answered
- **THEN** the failure is returned as that invocation's result
- **AND** the runtime does not exit

## MODIFIED Requirements

### Requirement: A capability's description says what withholding it costs

The agent-facing description of `spawn` SHALL tell a spawning model what a child is unable to do without each capability it may grant, in terms of what that child can still do.

A model choosing a child's tools is making an authority decision with only the description in front of it, and the consequences of withholding are not evenly distributed: an agent that holds no `send` still reports to its parent when its turn ends, because reporting at a turn boundary is not a capability and cannot be withheld. A description that leaves that unsaid invites a parent to believe it has silenced a child it has merely made less talkative, or to grant everything because it cannot tell what any of it costs.

Where a capability's usefulness depends on another capability being granted alongside it, the descriptions SHALL say so. `read` answers with a location in the agent's workspace, so an agent granted `read` and no means of reading a file receives an answer it cannot act on — a grant that appears to confer something and confers nothing. That SHALL be stated rather than repaired: a capability that silently widened a grant to make itself useful would make the authority a record describes differ from the authority it confers, which is a worse property than a grant that is merely inert and which is invisible at the moment the grant is made.

The description SHALL say that an expectation about the shape of an interaction — that a child answer once and stop, say — belongs in that child's charter rather than in its grant.

#### Scenario: A spawning model is told what a grant withholds

- **WHEN** a model reads the description of `spawn`'s tool grant
- **THEN** it is told that a child without `send` still reports when its turn ends
- **AND** it is told that a one-shot interaction is expressed in a charter rather than by withholding a capability

#### Scenario: A grant that depends on another grant says so

- **WHEN** a model reads the description of `read`, or of `spawn`'s tool grant
- **THEN** it is told that `read` answers with a location in the workspace
- **AND** it is told that an agent granted `read` without a means of reading a file cannot act on that answer
