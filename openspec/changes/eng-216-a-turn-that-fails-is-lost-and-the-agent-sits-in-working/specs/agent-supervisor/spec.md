## ADDED Requirements

### Requirement: An agent whose body ended is given a new one when it is addressed

The supervisor SHALL give a body to an agent that has none when a message is pending for it, whatever left it without one, and SHALL have that agent continue from its stored transcript rather than begin a new turn.

**This is the rule that already recovers a run, applied at delivery instead of at recovery.** Taking over a store boots every agent that was working and lets each continue from where it stopped. Nothing about that reasoning is peculiar to a supervisor starting up: an agent recorded as working is owed a step whether its log ends in a call nobody answered or in a step whose end nobody heard, and that is as true mid-run as it is at recovery.

Without it an agent whose body ended can never be reached again. Its ending is reported to its parent and its stored state is deliberately left alone so that the parent owns the decision — but the decision the parent owns is one it cannot carry out. Its transcript and its workspace are intact and sitting there, and the obvious response, telling the child to carry on, is the one response unavailable to it. The parent can replace the child or give up, and a substrate that offers only those has decided on the parent's behalf that stopping is fatal.

**A pending message SHALL be what triggers this, and the supervisor SHALL NOT revive an agent nobody has addressed.** Addressing the agent is the parent's decision and this carries it out; reviving on its own would move the judgment of whether to retry out of the parent's reasoning and into the substrate.

**What is pending SHALL remain pending.** An agent continuing an unfinished turn is not at the boundary where a message begins one, so the message SHALL be delivered at the boundary that agent reaches, by the ordinary path and in the ordinary order. It SHALL NOT be consumed by the act of giving the agent a body, and SHALL NOT be lost if that fails.

**A revival SHALL answer the message that caused it, so that a further revival requires a further message.** Because the message stays pending, it is still the pending message when the new body dies, and without this requirement it triggers another revival, and another: an agent that fails whenever it is given a body is given one without limit, on the strength of a single instruction nobody repeated. Each of those costs a sandbox, a boot, a model call and another report to a parent that is awake and spends a turn on each, and nothing is able to say so — which is the defect this change exists to remove, with a bill attached. The requirement bounds how many bodies one message buys; it does not consume the message, count attempts, or delay them.

A revival that could not be provisioned SHALL NOT count as one, because no body was produced and the parent has been told its message will be delivered when the agent can be provisioned again.

An agent that is working **and holds a body** SHALL NOT be given another and SHALL NOT be delivered to: that is an in-flight turn, which a message's arrival does not interrupt.

#### Scenario: A child whose body ended continues when its parent addresses it

- **WHEN** a parent sends a message to a child whose body has ended
- **THEN** the child is given a body and continues from its stored transcript
- **AND** the message is delivered to it at the turn boundary it reaches

#### Scenario: An agent nobody has addressed is left alone

- **WHEN** an agent's body ends and nothing is pending for it
- **THEN** the supervisor does not give it another body

#### Scenario: An in-flight turn is not interrupted

- **WHEN** a message arrives for an agent that is working and holds a body
- **THEN** the message waits, and no second body is created

#### Scenario: One message buys one body

- **WHEN** an agent revived by a pending message loses that body too, and nothing further is addressed to it
- **THEN** it is not given another body
- **AND** the message is still pending

#### Scenario: A further message buys a further body

- **WHEN** a parent addresses a child that a previous revival failed to keep alive
- **THEN** the child is given another body
- **AND** both messages are still pending, in the order they were sent

#### Scenario: A revival that cannot be provisioned loses nothing

- **WHEN** an agent whose body ended is addressed and no body can be provisioned for it
- **THEN** the condition is reported to its parent
- **AND** the message is still pending, and the agent is unchanged

## MODIFIED Requirements

### Requirement: An agent that ends without speaking is reported to its parent as a message

The supervisor SHALL detect an agent whose container ends without that agent having produced a message, and SHALL deliver a message to its parent's mailbox saying that it ended and what is known about how.

A parent suspended on a child that has died is waiting for a message that will never arrive, and without this nothing notices: the parent waits, the tree stops, and no failure is reported anywhere. Delivering the ending as an ordinary message makes it something the parent can reason about — retry, spawn a replacement, report upward, or give up — rather than something the substrate must decide on its behalf.

**The report SHALL say that the agent's work is kept and that it can be told to carry on**, because it can: its transcript and workspace survive its body, and addressing it gives it a new one. A report that reads as a death would have the parent replace an agent it could have continued, discarding the work that agent had already done. This is the account on which a parent chooses between retrying and replacing, so what it says about which are available is load-bearing.

The message SHALL be distinguishable from a message the agent itself produced, so that a parent is never misled about who spoke.

#### Scenario: A killed child wakes its parent

- **WHEN** a child's container is killed while its parent is suspended waiting on it
- **THEN** the parent receives a message reporting the ending
- **AND** the parent resumes rather than waiting indefinitely

#### Scenario: The ending is attributed to the substrate, not the agent

- **WHEN** a parent receives a report that its child ended
- **THEN** it is distinguishable from a message the child produced

#### Scenario: The report says the work is kept

- **WHEN** a parent receives a report that its child's body ended
- **THEN** it says the child's work is kept and that the child can be told to carry on

#### Scenario: An agent that spoke and then exited is not reported as terminated

- **WHEN** an agent produces its message and its container then ends
- **THEN** no termination report is delivered, because the agent said what it had to say

### Requirement: A stalled tree is detected and surfaced, never resolved

The supervisor SHALL detect the condition in which no agent in a run can make progress, and SHALL surface it to the human.

That condition is a tree that cannot move — a parent waiting on a child that is waiting on the parent is the ordinary shape of it — and it is a read of what each agent can still do rather than an inference about intent.

**An agent cannot move when it has nothing to act on and is not working in a body.** That is one condition covering three shapes: the agent suspended with an empty mailbox, the agent whose mail cannot be delivered because it cannot be provisioned, and the agent left with no body and nothing pending to give it one. The last is the backstop, and it holds whatever ended that agent — including causes the substrate cannot identify, which is what makes it a read of this whole class rather than a fix for one member of it.

A message that is pending for an agent the supervisor could not provision SHALL NOT count as progress for this purpose. Such a message is pending precisely because delivery failed, so reading it as work about to happen would report a tree that has stopped as a tree that is working — which is the one outcome this requirement exists to prevent.

**A message that has already been answered with a body SHALL NOT count as progress either.** An agent that will not be revived again is not made able to move by mail sitting in its box, and the requirement above bounding revival is what makes such mail possible. Without this the bound would trade an unbounded loop for an agent stopped in a way nothing can report — the same silence in a different shape.

**What is surfaced SHALL name the agents that are stopped as well as those that are waiting.** A report naming only the waiting ones, in a run brought to a halt by an agent whose body ended, names everything except the cause and sends the human to look at the agents that are behaving.

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

- **WHEN** every other agent is suspended and one agent has no body and nothing pending for it
- **THEN** the condition is surfaced to the human, because nothing will give that agent a body

#### Scenario: An agent whose body ended but which has mail is not a stall

- **WHEN** every other agent is suspended and one agent has no body and a message pending that has not yet been answered with one
- **THEN** the condition is not reported, because that message will give the agent a body

#### Scenario: A tree stopped by an agent holding mail it will not be revived for is reported

- **WHEN** every other agent is suspended and one agent has no body and the only message pending for it is the one its last body was given for
- **THEN** the condition is surfaced to the human, because that message will not give it another

#### Scenario: The report names what stopped, not only what is waiting

- **WHEN** the condition is surfaced in a run holding an agent whose body ended
- **THEN** that agent is named in what the human is told
- **AND** it is distinguishable there from the agents that are merely waiting
