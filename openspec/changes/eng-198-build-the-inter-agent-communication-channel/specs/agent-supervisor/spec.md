## ADDED Requirements

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
