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

A message that is pending for an agent the supervisor could not provision SHALL NOT count as progress for this purpose. Such a message is pending precisely because delivery failed, so reading it as work about to happen would report a tree that has stopped as a tree that is working — which is the one outcome this requirement exists to prevent.

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

A spawned child's environment, workspace path, and credential references SHALL be copied from its parent. The child's sandbox workspace SHALL remain isolated by the child's own id. The child SHALL inherit its parent's reasoning-model configuration, with only the `model` identifier replaced when the request supplies one. The request SHALL NOT override the `provider`, `baseURL`, or `credential` fields. Neither the request nor the child record SHALL carry a credential value.

Selecting the child's reasoning model SHALL have no bearing on what programs the child can run. A child reaches a coding assistant, where its environment provides one, only by holding the capability to run commands; there is no separate assistant configuration on a record for a spawn to inherit, override, or leave alone.

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

#### Scenario: A model override cannot redirect a credential

- **WHEN** a spawn request attempts to provide a model configuration with a different endpoint or credential rather than an identifier string
- **THEN** the supervisor refuses the spawn before creating a child

#### Scenario: Reaching an assistant is a tool grant, not a model choice

- **WHEN** a parent that can run commands spawns a child without granting that capability
- **THEN** the child cannot run an installed coding assistant
- **AND** the model identifier the request named has no bearing on that

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

### Requirement: A request is refused unless the caller's record names its kind

The supervisor SHALL refuse any request whose kind the caller's record does not name, and SHALL answer the caller saying so rather than failing silently or dropping the frame.

The check SHALL be made once, where every request arrives, and SHALL apply to every kind — including kinds added after it. A per-handler check is what this replaces: a rule enforced in some handlers and not others is reachable by exactly the agent it was written for, since an agent that hand-writes a raw frame is the one whose request should be trusted least.

This SHALL be the second of the two places a grant is enforced, and both SHALL remain. The runtime offers an agent only what its record names, and the supervisor reads the record again at the channel, because only one of the two is on the path a raw frame takes.

A record that names no messaging capability SHALL still be a coherent agent: messages reach it at a turn boundary, and reporting to its parent when its turn ends SHALL NOT require a grant. Withholding `send` SHALL narrow an agent to speaking when its turn ends rather than silence it.

#### Scenario: A raw frame for an ungranted kind is refused

- **WHEN** an agent whose record does not name `send` puts a `send` frame on the channel
- **THEN** the supervisor refuses it and answers the caller saying the record does not grant it
- **AND** nothing is delivered

#### Scenario: A granted kind is routed

- **WHEN** an agent whose record names `send` sends to its child
- **THEN** the request is routed as before

#### Scenario: An agent with no messaging capability still reports

- **WHEN** an agent whose record names neither `send` nor `await` finishes a turn
- **THEN** its report reaches its parent
- **AND** a message addressed to it is delivered when it next reaches a turn boundary

#### Scenario: The rule covers a kind added later

- **WHEN** a request kind the supervisor routes is not named by the caller's record
- **THEN** it is refused by the same check, without a check of its own

### Requirement: A request to receive a message names no sender

A request to receive a message SHALL name no sender, and SHALL be answered by the next message addressed to that agent whoever sent it.

An agent SHALL NOT be able to wait for a particular sender. The substrate holds one mailbox per agent in the order things arrived, and a request that could match some of it would leave the rest unread while its recipient slept — which a stalled tree is detected by every live agent waiting *and* every mailbox being empty, and so would read as a healthy tree indefinitely. Choosing what to do with a message that arrived from one child while another was expected is a judgment, and it belongs to the agent that can read who sent it.

A request to receive SHALL NOT carry a deadline. Acting on the absence of a message is the case a deadline answers, and nothing in the substrate requires it yet; adding one means a second clock beside the instruction an agent gives about its body, one that must start a dormant agent for the sole purpose of telling it nothing arrived.

#### Scenario: The next message answers, whoever sent it

- **WHEN** an agent waiting for a message is sent one by any agent it is related to
- **THEN** that message is delivered as the answer to its request

#### Scenario: A message that arrives while working is not lost

- **WHEN** a second message arrives for an agent that has resumed working
- **THEN** it waits in that agent's mailbox
- **AND** it is delivered when that agent next waits for one or reaches a turn boundary

### Requirement: A delivered message names who sent it

A message SHALL carry who sent it through delivery and into what its recipient reads, whether it is delivered as the answer to a request to receive or as the message that begins a turn.

A message from the human SHALL be distinguishable from a message from an agent, and a message from one agent SHALL be distinguishable from a message from another.

Without this a parent holding several children has several conversations in one mailbox with nothing to tell them apart, and the substrate's own answer to "wait, then decide" — that the agent reads who sent it and chooses — is unavailable to it.

#### Scenario: A parent can tell its children apart

- **WHEN** two children of one parent each report
- **THEN** each message the parent reads identifies the child that sent it

#### Scenario: The human is identified as the human

- **WHEN** the human addresses the agent nobody spawned
- **THEN** that agent reads the message as being from the human rather than from an agent

#### Scenario: Attribution survives a dormant delivery

- **WHEN** a message is delivered to an agent whose container is not running
- **THEN** what that agent reads on waking identifies the sender
- **AND** it is identified exactly as it would have been had the container still been running

### Requirement: An agent's own words cannot be read as another sender's

Where the substrate marks a message with who sent it, the content an agent authored SHALL NOT be readable as such a mark.

The mark is text the receiving agent reads, and the message beside it is text some other agent wrote, so nothing but the substrate's own handling separates them. A child that opens its report with something shaped like a mark — quoting a message it was itself sent, which is the way a confused agent reaches this rather than a hostile one — would otherwise be read by its parent as the substrate reporting a death, or as a sibling speaking.

This SHALL hold for every mark the substrate applies, including the one distinguishing a report of an agent's ending from a message that agent produced.

#### Scenario: A report that opens with a mark is not read as one

- **WHEN** an agent's message begins with text shaped like the substrate's own mark
- **THEN** its recipient reads it as that agent's words
- **AND** the mark identifying the true sender is still the one the recipient reads

#### Scenario: A genuine substrate report is still distinguishable

- **WHEN** the substrate reports that an agent ended
- **THEN** its recipient can tell that report from any message an agent produced

### Requirement: Delivery to one agent is independent of delivery to every other

The supervisor SHALL attempt delivery for every agent that has a message waiting, and a failure to deliver to one agent SHALL NOT prevent delivery to any other. An agent that cannot be given a body is one agent's trouble, and what is deliverable elsewhere in the tree is unchanged by it.

A request SHALL be answered by its own outcome and SHALL NOT be answered by what delivery did for anyone else. An agent that asked to spawn a child SHALL be told the child's id once that child's record and parentage are written; an agent that asked to send a message SHALL be told it was delivered once that message is durably in the recipient's mailbox. Neither answer asserts that any agent holds a body, so neither SHALL be turned into a refusal by an agent that has none.

A message that could not be handed over SHALL remain queued for its recipient, exactly as it was, and SHALL be delivered on a later attempt that succeeds. It SHALL NOT be delivered twice as a result of the attempt that failed.

#### Scenario: One agent's missing body does not fail another agent's request

- **WHEN** an agent's request is served while a different agent in the run cannot be provisioned
- **THEN** the request is answered by what it asked for, and is not refused

#### Scenario: A healthy agent is delivered to regardless

- **WHEN** an agent has a message waiting and another agent in the same run cannot be provisioned
- **THEN** the waiting message is delivered

#### Scenario: A parent whose child has no body can still be served

- **WHEN** a parent's first child could not be provisioned, and that parent makes a further request
- **THEN** the further request succeeds

#### Scenario: An undelivered message survives to be delivered later

- **WHEN** a message cannot be handed over because its recipient cannot be provisioned, and a later attempt succeeds
- **THEN** the recipient receives that message
- **AND** it receives it exactly once

### Requirement: An agent whose body cannot be provisioned is reported to its parent

The supervisor SHALL report to an agent's parent that the agent could not be given a body, naming the agent and what is known about why. The report SHALL be delivered as a message in the parent's mailbox, by the same path a message from any other source takes, so that the parent can retry, replace the agent, escalate or give up. The supervisor SHALL NOT choose among those on the parent's behalf.

The root's parent is the human, so a root that cannot be provisioned SHALL be reported to the human by that same path.

The report SHALL be distinguishable from a message the agent itself produced, and SHALL be distinguishable from a report that an agent ended without speaking — the agent has not spoken, has not ended, and remains addressable.

The report SHALL say that what was queued for the agent is still queued and that delivery will be attempted again, so that a parent does not conclude its message was lost and send it a second time.

An agent that cannot be provisioned SHALL be reported once for as long as that condition lasts, and SHALL NOT be reported again for each later attempt. An agent that is reached, and later cannot be reached again, SHALL be reported again.

#### Scenario: A parent learns its child has no body

- **WHEN** a child cannot be provisioned to receive what its parent sent it
- **THEN** the parent receives a message naming that child and what is known about the failure

#### Scenario: The report is attributed to the substrate and is not a death

- **WHEN** a parent receives a report that its child could not be provisioned
- **THEN** it is distinguishable from a message the child produced
- **AND** it is distinguishable from a report that the child ended without speaking

#### Scenario: One outage is reported once

- **WHEN** an agent cannot be provisioned and further requests are served while that is still true
- **THEN** its parent is told once rather than once per attempt

#### Scenario: A root that cannot be provisioned reaches the human

- **WHEN** the agent nobody spawned cannot be provisioned to receive a message
- **THEN** the human is told, by the path that carries the root's own messages to them

### Requirement: Recovering a run reports what it could not recover, and can be run again

When the supervisor takes over a run, an agent that cannot be provisioned SHALL NOT prevent the recovery of any other agent in that run, and each remaining agent SHALL be recovered as though the failure had not happened.

The supervisor SHALL report an agent it could not recover to that agent's parent, on the same terms as any other agent that could not be given a body.

An agent that could not be recovered SHALL be left exactly as it was stored, so that recovering the run again provisions it without any of its work having been lost or repeated.

#### Scenario: One agent that cannot boot does not abort the recovery

- **WHEN** a run is taken over and one of its agents cannot be provisioned
- **THEN** every other agent in that run is recovered

#### Scenario: A failed recovery is reported

- **WHEN** an agent cannot be provisioned while its run is being taken over
- **THEN** its parent is told that it could not be given a body

#### Scenario: Recovery can be repeated for what it missed

- **WHEN** a run is taken over a second time after an agent that could not be provisioned becomes provisionable
- **THEN** that agent is recovered and continues from its stored transcript

### Requirement: A message given to a body outlives the supervisor ending that body

Where the supervisor has taken a message from an agent's mailbox and given it to a running body without having stored it anywhere, and then ends that body itself, it SHALL return that message to the agent's mailbox and the agent to the state it was taken from. It SHALL return it once, ahead of anything queued behind it, and SHALL NOT return it once the body has reported recording it.

A message that answers an outstanding request is durable before any body reads it: for a dormant agent it is written into the log before anything boots, and for a running one it becomes that request's stored result. A message that *begins a turn* is neither. It is recorded by the agent's own runtime as the first act of that turn, so between leaving the mailbox and being written down it exists in the channel and nowhere else.

That is survivable for a body that dies, because the ending is reported to the agent's parent as a message the parent can act upon. It is not survivable for a body the supervisor ends, because an ending the supervisor intended is reported to nobody. Ending a run directly after addressing its root is the ordinary way to reach it — a person says one more thing and closes the window — and what it costs is that instruction, silently: gone from the mailbox, absent from the transcript, and the agent left recorded as working over a log with nothing new in it.

**Returning a message is not the end of it.** Where the supervisor ended the body for its own reasons and the run carries on — an agent's residency elapsing is the ordinary case, and the one that happens without anybody asking for it — the returned message SHALL be delivered rather than left waiting. Nothing else would find it: delivery happens when the supervisor settles, and an agent holding mail is read as a tree that is still moving, so a run reporting that it cannot proceed would not report this either. The result would be the same silence the return exists to end, reached through the return. Where the supervisor is ending the run or dismissing the agent there is nothing to deliver it to, and it waits for whoever takes the run up next. **And ending a run bounds delivery for work already under way, not only for the ending itself**: once a run is being ended the supervisor SHALL deliver no message to it, including where the work that would have delivered began before the ending did. A residency that elapses while the run is being ended, and a request that reached the supervisor from a body the ending had not yet got to, both arrive after the messages have been returned to their mailboxes, and each would read the run as one with work to do. Since a dormant agent is given a body in order to deliver to it, this is also what keeps a sandbox from outliving the run that created it — through the action a person takes to stop for the day, which is the worst way to fail it.

A body that ended without the supervisor intending it SHALL NOT have its message returned this way. Its parent is told that it terminated and chooses what to do about that; returning the message would additionally wake the agent on the supervisor's own initiative, which is a retry, and choosing whether to retry is the judgment the report exists to leave with the parent.

#### Scenario: A run ended before the body recorded what it was given

- **WHEN** a message is delivered to a running body and the run is ended before that body reports recording it
- **THEN** the message is back in that agent's mailbox
- **AND** the agent is back in the state the message was taken from

#### Scenario: What was returned is delivered when the run is taken up again

- **WHEN** a run whose message was returned this way is started again
- **THEN** the message is delivered to that agent
- **AND** it is delivered once

#### Scenario: A message the body recorded is left alone

- **WHEN** a body reports recording the message it was given, and the run is then ended
- **THEN** nothing is returned to that agent's mailbox

#### Scenario: A body ended because the agent's residency elapsed

- **WHEN** a body is ended because the agent's residency elapsed, holding a message it never recorded
- **THEN** the message is back in that agent's mailbox
- **AND** it is delivered to that agent without the run being ended and taken up again

#### Scenario: Work begun before a run was ended provisions nothing

- **WHEN** an agent's residency elapses while its run is being ended, or a request arrives from a body the ending has not yet reached
- **THEN** no body is provisioned for any agent of that run
- **AND** the messages returned to their mailboxes are still there for whoever takes the run up next

#### Scenario: A body that died is reported rather than rewound

- **WHEN** a body ends without the supervisor intending it, holding a message it never recorded
- **THEN** its parent is told that it terminated
- **AND** the message is not returned to its mailbox

### Requirement: No part of a body's channel goes unread, and no one body's channel holds up another

The supervisor SHALL read every stream a body's process offers, for as long as that process offers it, including a stream it has no use for. And a write to one body's input SHALL NOT hold up work for any other agent.

Both follow from what the channel is. It is a pipe with a finite buffer and a single thread behind it, so an unread stream is a stream that fills, and a process whose output is blocked is a process that has stopped — not reading its input, not taking a step, not ending. Its container is up, it uses no processor, its stored state still says it is working, and there is no way to tell it from an agent that is thinking. That is the one failure the substrate must not be able to produce quietly, and leaving a stream with no reader at all produces it without the agent doing anything unusual.

A body that has stopped this way, or for any other reason, is also one a write to does not come back from — not as a failure, which is reported by that body's own ending, but not at all. Waiting for such a write is what turns one stuck agent into a stopped run: no delivery to anyone, no frame read from any other body, nothing written to any transcript, and no condition reported anywhere, because every agent's records still say work is under way. Nothing is owed by the wait either, since what a body does with what it is sent is not something the send can report. The order frames are said to *one* body in SHALL be preserved.

What a body wrote on its standard error before ending SHALL be carried in the report its parent is given. A signal and an exit code say that a child stopped; a runtime that could not read what it was booted with, or that failed mid-turn, says why there and nowhere else, and a parent choosing between retrying, replacing and escalating is choosing on that.

#### Scenario: A body that writes more than the channel holds still finishes its turn

- **WHEN** an agent's body writes more to a stream the supervisor does not otherwise use than that channel can hold
- **THEN** the body continues, takes its turn, and reports

#### Scenario: One body that takes nothing is one agent's trouble

- **WHEN** a message is handed to a body that accepts nothing sent to it and reports nothing about it
- **THEN** another agent's request is still answered, and another agent is still delivered to
- **AND** nothing is reported as the supervisor's own failure

#### Scenario: A body's last words reach its parent

- **WHEN** a body ends without the supervisor intending it, having written to its standard error
- **THEN** the report its parent is given names how it ended and carries what it said

#### Scenario: A body that said nothing is reported as before

- **WHEN** a body ends without the supervisor intending it, having written nothing to its standard error
- **THEN** the report its parent is given names how it ended and claims nothing further
