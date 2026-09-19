## ADDED Requirements

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
