## ADDED Requirements

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

## MODIFIED Requirements

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
