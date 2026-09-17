## MODIFIED Requirements

### Requirement: The runtime's reasoning loop is its own

The runtime SHALL conduct its own reasoning loop: it decides when to call the model, dispatches the capabilities the model calls, appends their results, and decides when the exchange is over. It SHALL NOT delegate that control flow to a client library, a framework, or to any program it runs.

A step is one model call together with the results of the capabilities it invoked. A turn is a message from the agent's parent through to the agent's reply. A turn SHALL end when the model produces content with no capability calls outstanding; that content is the agent's message to its parent. There SHALL be no separate completion channel and no status field an agent writes to signal that it has finished.

The distinction matters because a coding assistant is a program the agent runs, not the agent's loop. If the assistant's loop were the agent's, the agent's behaviour would change wholesale with the assistant rather than one of its tools changing. The runtime therefore holds no concept of an assistant at all: an assistant is reached through the ordinary command-running capability, and nothing in the loop, the dispatcher, or the protocol distinguishes it from any other program.

#### Scenario: A turn ends on content with nothing outstanding

- **WHEN** the model returns content and calls no capability
- **THEN** the turn ends and that content is the agent's message to its parent

#### Scenario: A step continues when capabilities are called

- **WHEN** the model calls one or more capabilities
- **THEN** each is dispatched, its result is appended to the log, and the loop takes another step

#### Scenario: The loop is not delegated

- **WHEN** the runtime's use of its model client is examined
- **THEN** it does not use any facility of that client that would run the capability-dispatch loop on its behalf

#### Scenario: Running an assistant is not delegating the loop

- **WHEN** an agent runs a headless coding assistant as a command
- **THEN** the result returns to the same loop as any other capability result
- **AND** the agent decides what to do next

## ADDED Requirements

### Requirement: A capability may bound the work it starts

A capability that starts work the runtime cannot otherwise end SHALL bound that work itself and SHALL report reaching the bound as a failed result rather than by raising an error or by never returning.

The runtime SHALL NOT be relied upon to cancel a capability in progress. It passes a signal for a capability that has somewhere to hear about suspension, and that signal is not a guarantee that any invocation will be interrupted. A capability whose work can fail to terminate SHALL therefore carry its own bound, because the loop dispatches capabilities one after another and an invocation that never returns is an agent that never returns.

#### Scenario: An unbounded capability cannot stall the agent

- **WHEN** a capability starts work that does not finish
- **THEN** the capability ends that work at its own bound and returns a failed result
- **AND** the agent takes its next step

#### Scenario: The runtime is not the canceller

- **WHEN** a capability is in progress
- **THEN** nothing in the loop is required to interrupt it for the agent to remain able to proceed
