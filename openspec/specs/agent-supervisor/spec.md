# agent-supervisor Specification

## Purpose

Defines the host process that sits outside every sandbox and holds what no agent may: the framed channel it answers agents on, the mailboxes messages move through, the durable store of records and transcripts, the suspension and resumption of agents whose containers come and go, and the failures it turns into ordinary input rather than silence.

## Requirements

### Requirement: The supervisor is the one component outside every agent, and holds no judgment

The substrate SHALL provide a supervisor: a host process outside every sandbox, holding the capabilities no agent may hold — provisioning and destroying sandboxes, routing messages between agents, and storing records and transcripts.

Those capabilities live outside every agent because the alternatives fail. A parent servicing its children's requests leaves the agent nobody spawned needing a path none of the others use, since it has no parent to ask; that makes the root structurally special, which the substrate's homogeneity constraint forbids. A sandbox-provisioning capability held inside every runtime is homogeneous, but it grants every agent at every depth authority over the host equivalent to the runtime's own, and it requires an agent's body to outlive every descendant that might still run — which forecloses suspension entirely.

The supervisor SHALL hold no reasoning and SHALL make no decision reserved to an agent. It SHALL NOT encode a rule about what a given role may do, SHALL NOT decide when an agent has finished, SHALL NOT decide how long an agent's body should be kept, and SHALL NOT resolve a stalled tree. Where a decision is available, the supervisor SHALL offer the alternatives and execute what it is told.

This is the substrate's one non-homogeneous component, accepted deliberately, and its size is the price paid for it. Every behaviour it grows that an agent could have expressed instead is a policy moved out of the weights and into code, where no charter can reach it.

#### Scenario: Every runtime is identical and none holds these capabilities

- **WHEN** the runtime of the agent nobody spawned is compared with the runtime of an agent at any depth
- **THEN** they are the same
- **AND** neither contains the means to provision a sandbox, route a message, or read another agent's transcript

#### Scenario: The supervisor executes rather than decides

- **WHEN** the supervisor is asked to act on an agent's behalf
- **THEN** it performs what it was asked
- **AND** it applies no rule of its own about whether that agent should have asked

### Requirement: The runtime and the supervisor converse in framed messages over the runtime's standard streams

The supervisor SHALL converse with each agent's runtime over that runtime's standard input and standard output, in discrete framed messages, on the channel that remains after the runtime's boot input.

An agent SHALL reach every capability it does not hold by raising a request on that channel and waiting for the answer; the supervisor SHALL answer on the same channel. A request and its answer SHALL be correlated, so that an agent with several requests outstanding can tell which answer belongs to which.

The channel SHALL NOT be a broker, a network port, a daemon, or a shared bus, and there SHALL be no network path between agents. A project holds tens of agents rather than thousands, and a message fabric at that scale is machinery whose operational cost exceeds what it coordinates.

Requests the supervisor answers SHALL be extensible without reshaping the channel: the kinds an agent may raise are expected to grow, and a channel that must change to carry a new one would make each new capability a change to the substrate's transport.

#### Scenario: An agent's request is answered on the channel it was raised on

- **WHEN** an agent's runtime raises a request
- **THEN** the supervisor receives it and answers on the same channel
- **AND** the runtime continues from the answer

#### Scenario: Concurrent requests are told apart

- **WHEN** an agent raises more than one request before either is answered
- **THEN** each answer identifies the request it belongs to
- **AND** the runtime matches each to the request that is waiting for it

#### Scenario: No network path exists between agents

- **WHEN** the means by which two agents' runtimes could reach each other is examined
- **THEN** there is none: neither listens on a port, and no broker or bus stands between them

#### Scenario: A malformed frame does not end the agent

- **WHEN** the supervisor receives a frame it cannot read
- **THEN** it reports the failure to the agent that sent it
- **AND** the agent's other outstanding requests are unaffected

### Requirement: Every agent has a mailbox, and messages flow parent to child only

The supervisor SHALL hold one mailbox per agent, addressed by that agent's id.

A message SHALL be deliverable only between an agent and its parent, or an agent and one of its children. An agent SHALL NOT be able to send a message to its sibling, to its ancestor other than its parent, or to any agent it is not directly related to. The topology is a tree, so routing is a parent pointer and a list of children; there is no graph and there is no route to compute.

A message SHALL reach the recipient's conversation by one of exactly two paths, chosen by what that agent is doing and by nothing else. A message arriving for an agent that has asked to receive one SHALL be delivered as the result of that request. A message arriving for an agent that is at a turn boundary SHALL begin a new turn, in the position that agent's parent occupies in its conversation.

A message that begins a turn SHALL do so identically at every depth: a human addressing the agent nobody spawned and an agent addressing one of its children SHALL be the same operation, through the same path. The human SHALL be a participant in this graph rather than an exception to it — the root's parent is the human, and a message the root addresses to its parent SHALL be surfaced to them.

A message addressed to an agent that is working SHALL be held and delivered when that agent next reaches one of those two points. An in-flight turn SHALL NOT be interrupted by a message's arrival.

#### Scenario: A parent and a child exchange messages

- **WHEN** a parent sends a message to its child, and the child replies
- **THEN** each is delivered to the other's mailbox

#### Scenario: A sibling cannot be addressed

- **WHEN** an agent attempts to send a message to an agent that is neither its parent nor its child
- **THEN** the message is not delivered
- **AND** the sending agent is told it was refused rather than left believing it was sent

#### Scenario: The human and a parent reach an agent identically

- **WHEN** a human addresses the agent nobody spawned, and that agent addresses one of its children
- **THEN** the message arrives in each recipient's conversation in the same position, by the same path

#### Scenario: A message answers an agent that asked for one

- **WHEN** a message arrives for an agent that has asked to receive one
- **THEN** it is delivered as the result of that request
- **AND** the agent continues the turn it was in rather than beginning a new one

#### Scenario: A message to a working agent waits

- **WHEN** a message is delivered to an agent that is mid-turn and has not asked to receive one
- **THEN** the turn in progress runs to its end uninterrupted
- **AND** the message is delivered when that agent next reaches a turn boundary

### Requirement: Records and transcripts are durable, and live outside the container

The supervisor SHALL store every agent's record and every agent's transcript outside that agent's container, and both SHALL survive the container's destruction.

An agent SHALL exist in a project because its record exists, not because a process is running. There SHALL be no state in which an agent's existence depends on a container: an agent with no container running is an agent that is not currently working.

A transcript SHALL be appended to as events occur, rather than collected and written when an agent stops. An agent's container may end at any moment, including by a failure nothing anticipated, and a transcript written at the end is a transcript lost exactly when it is most needed.

The supervisor SHALL store transcripts as the event log the runtime emits, and SHALL NOT store them as the message array sent to a model provider. The log carries what that array cannot — when each step occurred, what it cost, how long each capability invocation took and whether it succeeded — and that detail is what makes a transcript a verification surface rather than merely a resumable one. Storing the provider's own shapes would additionally place the durable record on the far side of a seam the substrate expects to move.

#### Scenario: An agent outlives its container

- **WHEN** an agent's container is destroyed
- **THEN** its record and its transcript remain
- **AND** the agent can be started again from them

#### Scenario: Events are durable as they happen

- **WHEN** an agent produces several events and its container then ends without warning
- **THEN** every event produced before the ending is in the stored transcript

#### Scenario: The stored form is the event log

- **WHEN** a stored transcript is read
- **THEN** it carries, for each step, when it occurred, what it cost, and for each capability invoked its duration and outcome

### Requirement: An agent's transcript is durable before its container is allowed to exit

Where an agent's container is to be ended as part of a suspension, the supervisor SHALL have stored every event that agent produced before the container is ended.

This is the property the whole suspension model rests on, and it is the one ordering that cannot be relaxed. An agent resumed from a transcript missing its final steps does not fail — it silently repeats work it had already done, or reports on work that is no longer there, and nothing distinguishes that from an agent that behaved correctly.

#### Scenario: A suspension does not race the store

- **WHEN** an agent suspends and its container is ended
- **THEN** every event it produced was stored before the container ended

#### Scenario: A resumed agent resumes from a complete transcript

- **WHEN** an agent is suspended and then resumed
- **THEN** the transcript it resumes from ends at the point the agent suspended, with no step missing

### Requirement: A suspended agent resumes indistinguishably from one that never stopped

When a message arrives for an agent whose container is not running, the supervisor SHALL provision a fresh sandbox from that agent's record, boot a runtime in it with the stored transcript, and deliver the message, so that the agent continues as though the call it suspended on had returned.

Nothing in the runtime SHALL distinguish a resumed agent from one that was never interrupted, and there SHALL be no mode, flag or code path that means "was resumed". The runtime's requirement that a resumed agent produce byte-identical requests is what makes this available; this requirement is what exercises it.

The agent's workspace SHALL be the same workspace across suspensions. What the agent leaves on its filesystem survives; what is lost is only the state of processes that were running, which is the suspension model's one real cost.

#### Scenario: A message wakes a dormant agent

- **WHEN** a message is delivered to an agent whose container is not running
- **THEN** a sandbox is provisioned, the agent is booted from its record and transcript, and the message is delivered
- **AND** the agent continues from the point it suspended

#### Scenario: Nothing marks the resumption

- **WHEN** a resumed agent's conversation is compared with that of an agent that ran the same steps uninterrupted
- **THEN** neither the agent nor the model can tell which is which

#### Scenario: The workspace survives the suspension

- **WHEN** an agent writes to its workspace, suspends, and is resumed
- **THEN** what it wrote is there

#### Scenario: A whole tree survives the loss of every container

- **WHEN** a tree of agents is working and every process and container belonging to the run is killed abruptly
- **THEN** each agent can be resumed from records and transcripts alone
- **AND** each continues at the point it had reached

### Requirement: How long an agent's body is kept is named by the agent

A suspension SHALL carry the suspending agent's own instruction about how long its container is to be kept running before being torn down. The supervisor SHALL honour that instruction and SHALL hold no grace period, idle constant, timeout default, or adaptive heuristic of its own by which it would decide.

Only the agent can know which case it is in, because it has just decided what it dispatched. An agent coordinating several short-lived children may be woken seconds after suspending, repeatedly, and would pay a container start each time for nothing; an agent waiting on a day of work should cost nothing at all meanwhile. Both are expressible, and neither is the supervisor's to choose — a constant in the supervisor deciding it would be policy in code, which the substrate places in the weights.

Where an agent suspends without expressing an instruction, the suspension SHALL carry the instruction to keep nothing. That is the absence of a request rather than a choice made on the agent's behalf, and it SHALL be expressed by the runtime rather than supplied by the supervisor.

Tearing a container down SHALL NOT alter the agent's state. An agent whose body was kept and one whose body was torn down SHALL be in the same state and SHALL resume identically.

#### Scenario: An agent asks to be kept and is kept

- **WHEN** an agent suspends asking that its container be kept for a period, and is woken within that period
- **THEN** its container was still running
- **AND** no sandbox was provisioned to wake it

#### Scenario: An agent asks for nothing and is torn down

- **WHEN** an agent suspends asking that nothing be kept
- **THEN** its container is ended

#### Scenario: The supervisor holds no constant of its own

- **WHEN** the supervisor is examined for a period, interval or threshold governing how long a suspended agent's container is kept
- **THEN** there is none, and every such period comes from the suspending agent

#### Scenario: Dormant agents hold nothing

- **WHEN** every agent in a run is suspended having asked that nothing be kept
- **THEN** no container belonging to the run is running

#### Scenario: Residency does not change what an agent is

- **WHEN** an agent that asked to be kept and an agent that asked for nothing are each woken by the same message
- **THEN** each resumes in the same state it suspended in

### Requirement: An agent that ends without speaking is reported to its parent as a message

The supervisor SHALL detect an agent whose container ends without that agent having produced a message, and SHALL deliver a message to its parent's mailbox saying that it ended and what is known about how.

A parent suspended on a child that has died is waiting for a message that will never arrive, and without this nothing notices: the parent waits, the tree stops, and no failure is reported anywhere. Delivering the ending as an ordinary message makes it something the parent can reason about — retry, spawn a replacement, report upward, or give up — rather than something the substrate must decide on its behalf.

The message SHALL be distinguishable from a message the agent itself produced, so that a parent is never misled about who spoke.

#### Scenario: A killed child wakes its parent

- **WHEN** a child's container is killed while its parent is suspended waiting on it
- **THEN** the parent receives a message reporting the ending
- **AND** the parent resumes rather than waiting indefinitely

#### Scenario: The ending is attributed to the substrate, not the agent

- **WHEN** a parent receives a report that its child ended
- **THEN** it is distinguishable from a message the child produced

#### Scenario: An agent that spoke and then exited is not reported as terminated

- **WHEN** an agent produces its message and its container then ends
- **THEN** no termination report is delivered, because the agent said what it had to say

### Requirement: Everything a run creates is labelled with that run and swept by that label

The supervisor SHALL mark every sandbox it provisions as belonging to its run, at the moment of provisioning, and SHALL be able to end every sandbox of a run from that marking alone, holding no handle on any of them.

The case this exists for is a supervisor killed while sandboxes were running. Nothing remains to walk the tree, and a handle on a running sandbox is not something that survives the process that held it — so a sweep driven by what the supervisor remembers finds nothing, while one driven by the marking finds exactly what leaked. Marking at provisioning rather than afterwards is what makes this hold for a run that died between provisioning a sandbox and recording that it had.

**The sweep SHALL end sandboxes and SHALL NOT release any workspace.** It runs after a failure, which is the moment every agent's work is sitting in its workspace waiting to be resumed from. A sweep that took workspaces with it would destroy that work exactly when it is least recoverable, through a call whose purpose reads as tidying up.

A swept run SHALL remain resumable: every agent's record, transcript and workspace survives the sweep, and an agent that was working continues from its stored transcript.

This SHALL be performed on demand, not by a process that watches the tree.

#### Scenario: What a killed run left behind is found and ended

- **WHEN** a run is killed with sandboxes running, and that run is swept
- **THEN** every sandbox belonging to it is ended
- **AND** no handle on any of them was needed to do it

#### Scenario: A sweep leaves every workspace intact

- **WHEN** agents have written to their workspaces and their run is swept
- **THEN** every workspace still exists with its contents

#### Scenario: A swept run resumes

- **WHEN** a run is killed, swept, and then resumed
- **THEN** each agent continues from its stored transcript, in its own workspace

#### Scenario: A sweep does not reach another run

- **WHEN** two runs have sandboxes running and one is swept
- **THEN** the other run's sandboxes are untouched

### Requirement: A stalled tree is detected and surfaced, never resolved

The supervisor SHALL detect the condition in which every agent in a run is suspended with no message pending anywhere, and SHALL surface it to the human.

That condition is a tree that cannot make progress — a parent waiting on a child that is waiting on the parent is the ordinary shape of it — and it is a read of the mailbox state rather than an inference about intent.

The supervisor SHALL NOT resolve it: it SHALL NOT send a message of its own, SHALL NOT wake an agent, and SHALL NOT terminate one. Choosing how to break a deadlock is a judgment about the work, and the human is who the substrate has for that.

#### Scenario: A stalled tree is reported

- **WHEN** every agent in a run is suspended and no message is pending
- **THEN** the condition is surfaced to the human

#### Scenario: The supervisor does not break the deadlock

- **WHEN** a stalled tree is detected
- **THEN** no agent is woken, messaged, or terminated by the supervisor

#### Scenario: A run with work outstanding is not reported as stalled

- **WHEN** every agent is suspended but a message is pending delivery
- **THEN** the condition is not reported, because delivery will wake an agent

### Requirement: A transcript is readable by the agents accountable for it, in ranges

The supervisor SHALL serve an agent's request to read another agent's transcript, and SHALL serve it only where the target is a descendant of the requesting agent.

An agent may inspect the work it is accountable for. It SHALL NOT be able to read a sibling's transcript or an ancestor's; that restriction follows from the tree rather than from a policy about roles, which is what keeps it out of the class of rules the substrate places in the weights.

A read SHALL be answerable in ranges rather than only in whole. Transcripts grow without bound, and an agent that could only take all of a long one could not read it at all; a parent holding several children could not absorb several of them even if it could.

A refused read SHALL be reported to the requesting agent as a refusal, and SHALL NOT be answered with an empty transcript. Silence and emptiness are indistinguishable from a target that did nothing.

#### Scenario: A parent reads a descendant's transcript

- **WHEN** an agent requests the transcript of an agent below it in the tree
- **THEN** it is served

#### Scenario: A sibling's transcript is refused

- **WHEN** an agent requests the transcript of an agent that is not its descendant
- **THEN** the request is refused
- **AND** the refusal is distinguishable from a transcript with nothing in it

#### Scenario: A long transcript is read in parts

- **WHEN** an agent requests a range of a transcript
- **THEN** that range is served
- **AND** the agent can request further ranges to read the rest

### Requirement: Any agent granted spawn can create an agent of the same kind

The supervisor SHALL accept a `spawn` request from an agent with the `spawn` capability and SHALL construct the child as the same `AgentRecord` type used for the agent nobody spawned. It SHALL assign the child's id, set its parent to the caller, and SHALL NOT let the caller supply either field. The resulting record SHALL be persisted outside the sandbox with its parentage before the supervisor answers with the id. No root-specific construction path SHALL exist.

The request SHALL name a non-empty name and charter and MAY name an opening message, a tool list, and a non-empty reasoning-model identifier string. A missing opening message SHALL create a dormant child; a present opening message SHALL enter the child's mailbox and reach its conversation by the ordinary parent-to-child turn path.

The supervisor SHALL refuse a `spawn` request when the caller's record does not grant `spawn`, even if the request arrives on the channel.

#### Scenario: The root spawns a child

- **WHEN** the agent nobody spawned invokes `spawn` with a name and charter
- **THEN** the supervisor creates a child record whose parent is the caller and returns its assigned id
- **AND** the child's record has the same shape as the caller's record

#### Scenario: A spawned agent spawns again

- **WHEN** an agent whose own parent is another agent invokes `spawn`
- **THEN** the supervisor uses the same construction path as for the first generation
- **AND** the new child's parent is that calling agent

#### Scenario: An opening message starts the child

- **WHEN** a spawn request carries an opening message
- **THEN** the supervisor stores it in the child's mailbox and starts the child's first turn through the same path used for later parent messages

#### Scenario: No opening message leaves a valid dormant child

- **WHEN** a spawn request carries no opening message
- **THEN** the child record and parentage are stored and the child is waiting without a running body
- **AND** the id is returned so its parent can address it later

#### Scenario: A raw request cannot bypass the caller's record

- **WHEN** an agent whose record lacks `spawn` raises a `spawn` request on the channel
- **THEN** the supervisor refuses it and creates no child

### Requirement: Spawn inherits references and cannot widen authority

A spawned child's environment, workspace path, and credential references SHALL be copied from its parent. The child's sandbox workspace SHALL remain isolated by the child's own id. The child SHALL inherit its parent's reasoning-model configuration, with only the `model` identifier replaced when the request supplies one. The request SHALL NOT override the `provider`, `baseURL`, or `credential` fields. This model selection SHALL NOT select or configure a coding assistant, which is a separate capability. Neither the request nor the child record SHALL carry a credential value.

The child's tools SHALL be exactly the requested list if present, or an empty list if omitted. Every requested tool MUST already appear in the parent's tools. A malformed list, a duplicate name, a tool absent from the parent, or a malformed or empty model identifier SHALL cause an observable refusal before any child record, parent link, or sandbox is created. The supervisor SHALL NOT silently drop a requested tool or grant a tool the parent lacked.

#### Scenario: A parent grants a narrower child tool set

- **WHEN** a parent requests a child whose tools are a subset of its own
- **THEN** the child record contains exactly that requested subset
- **AND** the child's credentials remain references inherited from the parent

#### Scenario: An omitted tool list grants none

- **WHEN** a spawn request does not name tools
- **THEN** the child record has no tools
- **AND** the child does not gain `spawn` merely because its parent had it

#### Scenario: A requested tool would widen authority

- **WHEN** an agent requests a child tool it does not itself have
- **THEN** the supervisor refuses the spawn with a failed capability result naming the tool
- **AND** no child record, parent link, or sandbox is created

#### Scenario: The child chooses a model at its parent's endpoint

- **WHEN** a spawn request names a non-empty model identifier
- **THEN** the child record uses that identifier for its reasoning model
- **AND** its provider, endpoint, and credential reference remain the parent's
- **AND** its coding-assistant configuration is not changed by the model choice

#### Scenario: A model override cannot redirect a credential

- **WHEN** a spawn request attempts to provide a model configuration with a different endpoint or credential rather than an identifier string
- **THEN** the supervisor refuses the spawn before creating a child

### Requirement: Spawn returns an id without joining the child's work

The supervisor SHALL answer a valid `spawn` request after the child's record, parent link, and opening message if present are stored and delivery has been initiated. It SHALL NOT wait for the child to finish a turn, report, or complete work. Multiple spawn requests from one agent SHALL be able to create multiple children that are in flight before their parent takes its next model step.

#### Scenario: The child is still working when spawn returns

- **WHEN** a child has begun its opening turn and has not yet reported
- **THEN** the supervisor can return that child's id to its parent
- **AND** the parent is not made to wait for the report

#### Scenario: Fan-out does not join implicitly

- **WHEN** a parent makes four valid spawn requests in immediate succession
- **THEN** each is answered with a distinct durable child id without waiting for any child's report
- **AND** the four children can be in flight before the parent's next model step

### Requirement: An agent may dismiss its direct child's subtree

The supervisor SHALL honor a `stop` request only when the caller's record grants `stop` and the target is a direct child of the caller. It SHALL refuse any other caller or target observably. Stopping a child SHALL dismiss that child and every descendant, ending any live bodies while preserving all their records, transcripts, and workspaces. An agent's report SHALL NOT dismiss it; an agent remains available until stopped.

#### Scenario: Stopping a child dismisses the subtree

- **WHEN** a parent stops a child with descendants
- **THEN** the child and all descendants are dismissed and no body in that subtree remains running
- **AND** their workspaces and transcripts remain available

#### Scenario: A non-child cannot be stopped

- **WHEN** an agent requests `stop` for a sibling or another non-child
- **THEN** the supervisor refuses the request and dismisses nobody

#### Scenario: A caller without stop cannot dismiss its child

- **WHEN** an agent whose record lacks `stop` raises a `stop` request for its direct child
- **THEN** the supervisor refuses it and dismisses nobody

#### Scenario: A report leaves the agent available

- **WHEN** a child reports to its parent and no stop request follows
- **THEN** its record remains available for a later message
