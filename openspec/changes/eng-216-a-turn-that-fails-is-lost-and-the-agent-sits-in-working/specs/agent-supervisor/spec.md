## ADDED Requirements

### Requirement: A turn an agent could not complete is reported to its parent, and the agent stays addressable

The supervisor SHALL accept an agent's report that a turn could not be completed, SHALL return that agent to the state it holds at a turn boundary, and SHALL deliver a message to that agent's parent saying that the turn failed and what is known about why.

**A failure inside a living body is not a death, and SHALL NOT be reported as one.** An agent whose container ended has lost the process it was; an agent whose turn threw has lost one turn, with its conversation, its transcript and its workspace all intact. The difference is what the parent's options turn on: the cheapest response to a provider that refused once is to try again, and that is available for the second and not for the first. A substrate that ended the agent would be deciding that a transient refusal is fatal — a judgment about the work, made in code, where no charter can reach it.

**The agent SHALL be addressable afterwards.** A parent told that its child's turn failed SHALL be able to send that child a message and have it begin a new turn, without the child being replaced and without its transcript being abandoned.

The message SHALL be distinguishable from a message the agent itself produced, so that a parent is never misled about who spoke. The agent produced nothing — that is what failed — and a report presented as the agent's own words would put an account of a failure into the agent's mouth.

Where the agent that failed has no parent, the report SHALL reach the human, by the same path and in the same shape a root's own message does.

#### Scenario: A failed turn wakes the parent

- **WHEN** an agent's turn fails while its parent is suspended waiting on it
- **THEN** the parent receives a message reporting the failure and what is known about why
- **AND** the parent resumes rather than waiting indefinitely

#### Scenario: The failure is attributed to the substrate, not the agent

- **WHEN** a parent receives a report that its child's turn failed
- **THEN** it is distinguishable from a message the child produced

#### Scenario: An agent whose turn failed can be told to try again

- **WHEN** a parent sends a message to a child whose turn failed
- **THEN** the message is delivered and begins a new turn
- **AND** the child continues from the transcript it already had

#### Scenario: A root's failed turn reaches the human

- **WHEN** the turn that fails belongs to the agent nobody spawned
- **THEN** the report reaches the human rather than being dropped

## MODIFIED Requirements

### Requirement: A stalled tree is detected and surfaced, never resolved

The supervisor SHALL detect the condition in which no agent in a run can make progress, and SHALL surface it to the human.

That condition is a tree that cannot move — a parent waiting on a child that is waiting on the parent is the ordinary shape of it — and it is a read of what each agent can still do rather than an inference about intent.

A message that is pending for an agent the supervisor could not provision SHALL NOT count as progress for this purpose. Such a message is pending precisely because delivery failed, so reading it as work about to happen would report a tree that has stopped as a tree that is working — which is the one outcome this requirement exists to prevent.

**An agent recorded as working that holds no body SHALL NOT count as progress either.** Delivery reaches an agent at a turn boundary, so nothing will give such an agent a body and nothing will draw a message out of it: it is as unable to speak as a suspended one, and more permanently. This is the case left behind by an agent whose body ended without it having spoken, whose stored state is deliberately left as it was so that its parent owns the decision about it — and a parent that does not happen to dismiss it would otherwise make this condition unreportable for the rest of the run. This SHALL hold whatever ended the agent, including causes the substrate cannot identify, which is what makes it the backstop for this class rather than a fix for one member of it.

**What is surfaced SHALL name the agents that are stopped as well as those that are waiting.** A report naming only the waiting ones, in a run brought to a halt by an agent that stopped, names everything except the cause and sends the human to look at the agents that are behaving.

The supervisor SHALL NOT resolve it: it SHALL NOT send a message of its own, SHALL NOT wake an agent, and SHALL NOT terminate one. Choosing how to break a deadlock is a judgment about the work, and the human is who the substrate has for that.

#### Scenario: A stalled tree is reported

- **WHEN** every agent in a run is suspended and no message is pending
- **THEN** the condition is surfaced to the human

#### Scenario: The supervisor does not break the deadlock

- **WHEN** a stalled tree is detected
- **THEN** no agent is woken, messaged, or terminated by the supervisor

#### Scenario: A run with work outstanding is not reported as stalled

- **WHEN** every agent is suspended but a message is pending delivery to an agent that can be reached
- **THEN** the condition is not reported, because delivery will wake an agent

#### Scenario: A tree stopped by an agent that cannot be provisioned is reported

- **WHEN** every agent is suspended and the only message pending is for an agent that cannot be provisioned
- **THEN** the condition is surfaced to the human, because nothing pending can wake anyone

#### Scenario: A tree stopped by an agent whose body ended is reported

- **WHEN** every other agent is suspended and one agent is recorded as working with no body
- **THEN** the condition is surfaced to the human, because nothing will wake that agent either

#### Scenario: The report names what stopped, not only what is waiting

- **WHEN** the condition is surfaced in a run holding an agent that stopped
- **THEN** that agent is named in what the human is told
- **AND** it is distinguishable there from the agents that are merely waiting
