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
